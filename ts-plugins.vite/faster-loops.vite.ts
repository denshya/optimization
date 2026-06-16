import { Plugin } from 'vite';
import ts from 'typescript';

/**
 * Vite plugin to transform annotated `for...of` loops with the `/*@fast_loop*\/` pragma
 * into optimized branch-based loops using the TypeScript compiler API.
 */
export function vitePluginFasterLoop(): Plugin {
  return {
    name: 'vite-plugin-faster-loop',
    enforce: 'pre',
    transform(code, id) {
      // 1. Strip query parameters & fragments (e.g., index.ts?v=123 or Component.vue?vue&type=script)
      const [cleanId] = id.split(/[?#]/);

      // Only process TypeScript and JavaScript files
      if (!/\.(js|ts|jsx|tsx)$/.test(cleanId)) {
        return null;
      }

      // 2. Select the correct script kind to guarantee robust JSX/TSX parsing
      let scriptKind = ts.ScriptKind.TS;
      if (cleanId.endsWith('.tsx')) {
        scriptKind = ts.ScriptKind.TSX;
      } else if (cleanId.endsWith('.jsx')) {
        scriptKind = ts.ScriptKind.JSX;
      } else if (cleanId.endsWith('.js')) {
        scriptKind = ts.ScriptKind.JS;
      }

      // 3. Create TS Source File
      const sourceFile = ts.createSourceFile(
        id,
        code,
        ts.ScriptTarget.Latest,
        true, // Set parent pointers (required for context traversal)
        scriptKind
      );

      // Track whether we made any modifications so we don't needlessly print
      let hasModified = false;

      // 4. Define the TS AST Transformer
      const transformer = (context: ts.TransformationContext) => {
        return (rootNode: ts.Node) => {

          function visit(node: ts.Node): ts.Node {
            if (ts.isForOfStatement(node) && hasFasterLoopComment(node, sourceFile)) {
              hasModified = true;
              const transformed = transformForOf(node, context, sourceFile);
              if (transformed) {
                // Wrap in a clean block to prevent scoped variable collisions
                return ts.factory.createBlock(transformed, true);
              }
            }
            // Only descend if this subtree contains @fast_loop — avoids creating AST clones
            // that trigger a TS 6.x printer bug: comments on single-param arrow functions
            // (e.g. `/*@hoist*/ x => ...`) get doubled when removeComments: false.
            if (sourceFile.text.substring(node.getFullStart(), node.end).includes('@fast_loop')) {
              return ts.visitEachChild(node, visit, context);
            }
            return node;
          }

          return ts.visitNode(rootNode, visit);
        };
      };

      // 5. Transform the AST
      const result = ts.transform(sourceFile, [transformer]);

      if (hasModified) {
        const printer = ts.createPrinter({ removeComments: false });
        const transformedCode = printer.printFile(result.transformed[0] as ts.SourceFile);

        // Ensure FastArrayIterator is imported so the helper can reference it
        const alreadyImports = sourceFile.statements.some(stmt =>
          ts.isImportDeclaration(stmt) &&
          stmt.importClause &&
          stmt.importClause.namedBindings &&
          ts.isNamedImports(stmt.importClause.namedBindings) &&
          stmt.importClause.namedBindings.elements.some(
            el => el.name.text === 'FastArrayIterator'
          )
        );
        const importStmt = alreadyImports
          ? ''
          : 'import { FastArrayIterator } from "@/modules/common/FastArrayIterator";\n';

        return {
          code: importStmt + FAST_ITERATE_HELPER_SOURCE + '\n' + transformedCode,
          map: null,
        };
      }

      return null;
    },
  };
}

/**
 * Checks if a Node has the `/*@fast_loop*\/` leading pragma comment
 * by scanning the exact trivia range before the node starts.
 */
function hasFasterLoopComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const fileText = sourceFile.text;
  const start = node.getFullStart();
  const end = node.getStart(sourceFile);
  const trivia = fileText.substring(start, end);
  return trivia.includes('@fast_loop');
}

/**
 * TS version compatible wrapper for creating parameters (mismatched signatures between TS 4.x and 5.x)
 */
function safeCreateParameter(name: string | ts.BindingName): ts.ParameterDeclaration {
  if (ts.factory.createParameterDeclaration.length === 6) {
    // TS 4.8+
    return (ts.factory.createParameterDeclaration as any)(
      undefined,
      undefined,
      name,
      undefined,
      undefined,
      undefined
    );
  } else {
    // TS < 4.8
    return (ts.factory.createParameterDeclaration as any)(
      undefined,
      undefined,
      undefined,
      name,
      undefined,
      undefined,
      undefined
    );
  }
}

const FAST_ITERATE_HELPER_SOURCE = `
function __fastIterate(iterable, fn, thisArg) {
  if (Array.isArray(iterable)) {
    FastArrayIterator.view(iterable).forEach(fn, thisArg);
  } else if (iterable && typeof iterable.forEach === "function") {
    iterable.forEach(fn, thisArg);
  } else {
    const iterator = iterable instanceof Iterator ? iterable : iterable[Symbol.iterator]();
    let step;
    while (!(step = iterator.next()).done) {
      fn.call(thisArg, step.value);
    }
  }
}
`;

/**
 * Transforms a single for...of loop into an extracted closure + shared helper call.
 */
function transformForOf(
  node: ts.ForOfStatement,
  _context: ts.TransformationContext,
  _sourceFile: ts.SourceFile
): ts.Statement[] | null {
  const left = node.initializer;
  const right = node.expression;
  const body = node.statement;

  let loopVarName = '';
  if (ts.isVariableDeclarationList(left)) {
    const firstDec = left.declarations[0];
    if (ts.isIdentifier(firstDec.name)) {
      loopVarName = firstDec.name.text;
    }
  } else if (ts.isIdentifier(left)) {
    loopVarName = left.text;
  }

  if (!loopVarName) return null;

  const callbackParam = safeCreateParameter(ts.factory.createIdentifier(loopVarName));
  const indexParam = safeCreateParameter(ts.factory.createIdentifier('_i'));
  const callbackBody = ts.isBlock(body) ? body : ts.factory.createBlock([body], true);

  // 2. Define the visitor function to swap 'continue' with 'return'
  const visitor = (node: ts.Node): ts.Node => {
    if (ts.isContinueStatement(node)) {
      // Replaces `continue;` with `return;`
      return ts.factory.createReturnStatement(undefined);
    }
    // Recursively visit child nodes (like if-statements, inner blocks, etc.)
    return ts.visitEachChild(node, visitor, undefined);
  };

  // 3. Apply the transformation to the body
  const modifiedBody = ts.visitEachChild(callbackBody, visitor, undefined);

  const arrowFn = ts.factory.createArrowFunction(
    undefined, undefined, [callbackParam, indexParam], undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    modifiedBody
  );
  ts.addSyntheticLeadingComment(arrowFn, ts.SyntaxKind.MultiLineCommentTrivia, ' @hoist ', false);

  const helperCall = ts.factory.createExpressionStatement(
    ts.factory.createCallExpression(
      ts.factory.createIdentifier('__fastIterate'),
      undefined,
      [right, arrowFn, ts.factory.createThis()]
    )
  );

  return [helperCall];
}
