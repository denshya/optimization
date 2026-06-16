import { defineConfig } from 'vite';
import ts from 'typescript';

export function tsLoopFlattenPlugin() {
  return {
    name: 'vite-plugin-loop-flatten',
    enforce: 'pre' as const, // Run before Vite/esbuild strips comments and transpiles loops
    transform(code: string, id: string) {
      if (!id.endsWith('.ts') && !id.endsWith('.tsx') && !id.endsWith('.js')) return null;

      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
      const printer = ts.createPrinter({ removeComments: false });

      const transformer = (context: ts.TransformationContext) => {
        return (rootNode: ts.Node) => {
          function visit(node: ts.Node): ts.Node {

            // Target ForOfStatements and ForStatements marked with @flatten
            if ((ts.isForOfStatement(node) || ts.isForStatement(node)) && hasFlattenComment(node, sourceFile)) {

              // Correctly initialize to avoid 'used before assigned' issues
              let arrayExpr: ts.Expression = ts.factory.createPropertyAccessExpression(
                ts.factory.createThis(),
                ts.factory.createIdentifier('nodes')
              );
              let elementId = ts.factory.createIdentifier('node');
              let loopBody: ts.Statement;
              let indexId = ts.factory.createIdentifier('i');
              let lengthExpr: ts.Expression;

              if (ts.isForOfStatement(node)) {
                // Scenario A: for (const node of this.nodes)
                arrayExpr = node.expression;
                lengthExpr = ts.factory.createPropertyAccessExpression(arrayExpr, 'length');

                const initializer = node.initializer;
                if (ts.isVariableDeclarationList(initializer) && initializer.declarations.length > 0) {
                  const declName = initializer.declarations[0].name;
                  if (ts.isIdentifier(declName)) {
                    elementId = declName;
                  } else {
                    return node;
                  }
                } else {
                  return node;
                }
                loopBody = node.statement;
              } else {
                // Scenario B: for (let i = 0; i < this.length; i++)
                const initializer = node.initializer;
                const condition = node.condition;

                if (initializer && ts.isVariableDeclarationList(initializer) && initializer.declarations.length > 0) {
                  const declName = initializer.declarations[0].name;
                  if (ts.isIdentifier(declName)) indexId = declName;
                }

                if (condition && ts.isBinaryExpression(condition)) {
                  lengthExpr = condition.right;
                } else {
                  lengthExpr = ts.factory.createPropertyAccessExpression(ts.factory.createThis(), 'length');
                }

                loopBody = node.statement;
                if (ts.isBlock(loopBody) && loopBody.statements.length > 0) {
                  const firstStmt = loopBody.statements[0];
                  if (ts.isVariableStatement(firstStmt) && firstStmt.declarationList.declarations.length > 0) {
                    const decl = firstStmt.declarationList.declarations[0];
                    if (ts.isIdentifier(decl.name)) {
                      elementId = decl.name;
                      // Slice out the local 'const node = nodes[i]' statement as we'll hoist and recreate it
                      loopBody = ts.factory.createBlock(loopBody.statements.slice(1), true);
                    }
                  }
                }
              }

              const limitId = ts.factory.createIdentifier('__limit');
              const lenId = ts.factory.createIdentifier('__len');

              // Inside helper block utilizing correctly bound outer variables
              const createUnrolledBlock = (offset: number) => {
                const rewrittenBody = rewriteIndexAccess(loopBody, indexId, offset, context);

                const elementAssignment = ts.factory.createExpressionStatement(
                  ts.factory.createAssignment(
                    elementId,
                    ts.factory.createElementAccessExpression(
                      arrayExpr,
                      offset === 0 ? indexId : ts.factory.createBinaryExpression(indexId, ts.SyntaxKind.PlusToken, ts.factory.createNumericLiteral(offset))
                    )
                  )
                );

                if (ts.isBlock(rewrittenBody)) {
                  return [elementAssignment, ...rewrittenBody.statements];
                }
                return [elementAssignment, rewrittenBody];
              };

              // Compile 8-way unrolled paths
              const unrolledSteps: ts.Statement[] = [];
              for (let offset = 0; offset < 8; offset++) {
                unrolledSteps.push(...createUnrolledBlock(offset));
              }

              // Assemble unrolled and remainder loops
              return ts.factory.createBlock([
                // 1. Hoisted Variable Declarations
                ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
                  ts.factory.createVariableDeclaration(indexId, undefined, undefined, ts.factory.createNumericLiteral(0)),
                  ts.factory.createVariableDeclaration(elementId)
                ], ts.NodeFlags.Let)),

                ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
                  ts.factory.createVariableDeclaration(lenId, undefined, undefined, lengthExpr)
                ], ts.NodeFlags.Const)),

                // 2. Unrolled Fast Path: for (; i < __limit; i += 8)
                ts.factory.createIfStatement(
                  ts.factory.createBinaryExpression(lenId, ts.SyntaxKind.GreaterThanToken, ts.factory.createNumericLiteral(32)),
                  ts.factory.createBlock([
                    ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
                      ts.factory.createVariableDeclaration(
                        limitId,
                        undefined,
                        undefined,
                        ts.factory.createBinaryExpression(lenId, ts.SyntaxKind.AmpersandToken, ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, ts.factory.createNumericLiteral(8)))
                      )
                    ], ts.NodeFlags.Const)),
                    ts.factory.createForStatement(
                      undefined,
                      ts.factory.createBinaryExpression(indexId, ts.SyntaxKind.LessThanToken, limitId),
                      ts.factory.createBinaryExpression(indexId, ts.SyntaxKind.PlusEqualsToken, ts.factory.createNumericLiteral(8)),
                      ts.factory.createBlock(unrolledSteps, true)
                    )
                  ], true)
                ),

                // 3. Remainder Loop: for (; i < __len; i++)
                ts.factory.createForStatement(
                  undefined,
                  ts.factory.createBinaryExpression(indexId, ts.SyntaxKind.LessThanToken, lenId),
                  ts.factory.createPostfixUnaryExpression(indexId, ts.SyntaxKind.PlusPlusToken),
                  ts.factory.createBlock(createUnrolledBlock(0), true)
                )
              ], true);
            }
            return ts.visitEachChild(node, visit, context);
          }
          return ts.visitNode(rootNode, visit);
        };
      };

      const result = ts.transform(sourceFile, [transformer]);
      return {
        code: printer.printFile(result.transformed[0] as ts.SourceFile),
        map: null
      };
    }
  };
}

function rewriteIndexAccess(node: ts.Statement, indexId: ts.Identifier, offset: number, context: ts.TransformationContext): ts.Statement {
  if (offset === 0) return node;

  const visitor = (n: ts.Node): ts.Node => {
    if (ts.isIdentifier(n) && n.text === indexId.text) {
      return ts.factory.createParenthesizedExpression(
        ts.factory.createBinaryExpression(indexId, ts.SyntaxKind.PlusToken, ts.factory.createNumericLiteral(offset))
      );
    }
    return ts.visitEachChild(n, visitor, context);
  };

  return ts.visitNode(node, visitor) as ts.Statement;
}

function hasFlattenComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const start = node.pos;
  const end = node.getStart(sourceFile);
  const trivia = sourceFile.text.substring(start, end);
  return trivia.includes('@flatten');
}
