import type { Plugin } from 'vite'
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import { DENSE_REGISTRY, type DenseClassLayout, scanDenseClassLayout } from './dense.vite'

const DENSE_ITER_MARKER = '@dense_iter'
const PROJECT_SRC = path.resolve('src')

export function vitePluginDenseIter(): Plugin {
  return {
    name: 'vite-plugin-dense-iter',
    enforce: 'pre',
    transform(code: string, id: string) {
      const [cleanId] = id.split(/[?#]/)
      if (!/\.(ts|tsx)$/.test(cleanId)) return null
      if (!code.includes(DENSE_ITER_MARKER)) return null

      let scriptKind = ts.ScriptKind.TS
      if (cleanId.endsWith('.tsx')) scriptKind = ts.ScriptKind.TSX

      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, scriptKind)

      const missingClasses = findMissingDenseClasses(sourceFile)
      for (const cn of missingClasses) resolveAndRegister(sourceFile, cn)

      const result = ts.transform(sourceFile, [
        () => (rootNode: ts.Node) => {
          let modified = false

          function visit(node: ts.Node): ts.Node {
            if (ts.isForOfStatement(node)) {
              const className = hasDenseIterComment(node, sourceFile)
              if (className) {
                const layout = DENSE_REGISTRY.get(className)
                if (layout) { modified = true; return rewriteForOf(node, className, layout) }
              }
            }
            if (ts.isArrowFunction(node)) {
              const className = hasDenseIterComment(node, sourceFile)
              if (className) {
                const layout = DENSE_REGISTRY.get(className)
                if (layout) { modified = true; return rewriteSortComparator(node, className, layout) }
              }
            }
            return ts.visitEachChild(node, visit, undefined)
          }

          const transformed = ts.visitNode(rootNode, visit)
          if (!modified) return rootNode
          return transformed
        },
      ])

      const printer = ts.createPrinter({ removeComments: false })
      const transformedCode = printer.printFile(result.transformed[0] as ts.SourceFile)
      return { code: transformedCode, map: null }
    },
  }
}

// ── Lazy registry resolution ──

function findMissingDenseClasses(sf: ts.SourceFile): string[] {
  const names = new Set<string>()
  function visit(n: ts.Node) {
    if ((ts.isForOfStatement(n) || ts.isArrowFunction(n)) && !DENSE_REGISTRY.has(hasDenseIterComment(n, sf) ?? '')) {
      const cn = hasDenseIterComment(n, sf)
      if (cn) names.add(cn)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return [...names]
}

function resolveAndRegister(sourceFile: ts.SourceFile, className: string, trace = new Set<string>()): void {
  const specifier = findImportSpecifier(sourceFile, className)
  if (!specifier) return
  const resolved = resolveImportPath(specifier, sourceFile.fileName)
  if (!resolved || trace.has(resolved)) return
  trace.add(resolved)
  let source: string
  try { source = fs.readFileSync(resolved, 'utf-8') } catch { return }

  let layout = scanDenseClassLayout(source, className)
  if (layout) { DENSE_REGISTRY.set(className, layout); return }

  const reExport = findReExport(source, className)
  if (reExport) {
    const reResolved = resolveImportPath(reExport, resolved)
    if (!reResolved || trace.has(reResolved)) return
    trace.add(reResolved)
    let reSource: string
    try { reSource = fs.readFileSync(reResolved, 'utf-8') } catch { return }
    const reLayout = scanDenseClassLayout(reSource, className)
    if (reLayout) DENSE_REGISTRY.set(className, reLayout)
  }
}

function findImportSpecifier(sf: ts.SourceFile, className: string): string | null {
  let spec: string | null = null
  ts.forEachChild(sf, node => {
    if (!ts.isImportDeclaration(node)) return
    if (!node.importClause?.namedBindings) return
    if (!ts.isNamedImports(node.importClause.namedBindings)) return
    for (const el of node.importClause.namedBindings.elements) {
      if (el.name.text === className || (el.propertyName?.text === className)) { spec = node.moduleSpecifier.text; return }
    }
  })
  return spec
}

function resolveImportPath(specifier: string, fromFile: string): string | null {
  try {
    if (specifier.startsWith('@/')) return resolveWithExts(path.join(PROJECT_SRC, specifier.slice(2)))
    if (specifier.startsWith('.')) return resolveWithExts(path.join(path.dirname(fromFile), specifier))
    return null
  } catch { return null }
}

function resolveWithExts(p: string): string | null {
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const full = ext.startsWith('/') ? path.join(p, ext.slice(1)) : p + ext
    if (fs.existsSync(full)) return full
  }
  return null
}

function findReExport(source: string, className: string): string | null {
  const sf = ts.createSourceFile('re.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let spec: string | null = null
  ts.forEachChild(sf, node => {
    if (!ts.isExportDeclaration(node) || !node.exportClause) return
    if (!ts.isNamedExports(node.exportClause)) return
    for (const el of node.exportClause.elements) {
      if (el.name.text === className || (el.propertyName?.text === className)) {
        if (node.moduleSpecifier) { spec = node.moduleSpecifier.text; return }
      }
    }
  })
  return spec
}

// ── Helpers ──

function hasDenseIterComment(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const text = sourceFile.text
  const trivia = text.substring(node.getFullStart(), node.getStart(sourceFile))
  const match = trivia.match(/@dense_iter\((\w+)\)/)
  return match ? match[1] : null
}

function buildPropertyChain(expr: ts.Expression): { base: string | null; props: string[] } {
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = buildPropertyChain(expr.expression); inner.props.push(expr.name.text); return inner
  }
  if (ts.isIdentifier(expr)) return { base: expr.text, props: [] }
  return { base: null, props: [] }
}

function resolveArrayName(propName: string, layout: DenseClassLayout): string | null {
  const info = layout.fields.get(propName)
  return info ? info.arrayName : null
}

function copyLeadingComments(target: ts.Node, source: ts.Node): void {
  const sfText = source.getSourceFile().text
  const ranges = ts.getLeadingCommentRanges(sfText, source.getFullStart())
  if (!ranges) return
  for (const r of ranges) {
    const raw = sfText.slice(r.pos, r.end)
    const inner = r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? raw.slice(2, -2) : raw.slice(2)
    ts.addSyntheticLeadingComment(target, r.kind, inner, r.hasTrailingNewLine)
  }
}

/** Check if the for-of's leading trivia contains @fast_loop. */
function hasFastLoopTrivia(node: ts.ForOfStatement): boolean {
  const sf = node.getSourceFile()
  return sf.text.slice(node.getFullStart(), node.getStart(sf)).includes('@fast_loop')
}

// ── For-of rewrite ──

function rewriteForOf(
  node: ts.ForOfStatement,
  className: string,
  layout: DenseClassLayout,
): ts.Statement {
  const f = ts.factory

  let itemName = ''
  const init = node.initializer
  if (ts.isVariableDeclarationList(init) && init.declarations.length > 0) {
    if (ts.isIdentifier(init.declarations[0].name)) itemName = init.declarations[0].name.text
  }

  // ── @fast_loop present → keep for-of as-is, node getters access dense storage via _idx correctly ──
  if (hasFastLoopTrivia(node)) {
    const forOf = f.createForOfStatement(node.awaitModifier, node.initializer, node.expression, node.statement)
    copyLeadingComments(forOf, node)
    return forOf
  }

  // ── Standalone → indexed for with buffer reads ──
  const { rewriteNode, usedFields } = makeRewriteNode(f, itemName, layout, node.expression)

  const body = node.statement
  const innerStmts = ts.isBlock(body) ? [...body.statements] : [body]
  const rewrittenBody = innerStmts.map(s => ts.visitNode(s, rewriteNode) as ts.Statement)

  const indexedFor = f.createForStatement(
    f.createVariableDeclarationList([f.createVariableDeclaration('_i', undefined, undefined, f.createNumericLiteral(0))], ts.NodeFlags.Let),
    f.createBinaryExpression(f.createIdentifier('_i'), ts.SyntaxKind.LessThanToken, f.createPropertyAccessExpression(node.expression, 'length')),
    f.createPostfixIncrement(f.createIdentifier('_i')),
    f.createBlock(rewrittenBody),
  )

  return f.createBlock([preambleForLayout(f, className, layout, usedFields), indexedFor])
}

function preambleForLayout(
  f: typeof ts.factory,
  className: string,
  layout: DenseClassLayout,
  usedFields?: Set<string>,
): ts.VariableStatement {
  const decls: ts.VariableDeclaration[] = []
  for (const [name, info] of layout.fields) {
    if (usedFields && !usedFields.has(name)) continue
    decls.push(
      f.createVariableDeclaration(`_${name}`, undefined, undefined,
        f.createPropertyAccessExpression(f.createIdentifier(className), info.arrayName)),
    )
  }
  return f.createVariableStatement(undefined, f.createVariableDeclarationList(decls, ts.NodeFlags.Const))
}

// ── Sort comparator rewrite ──

function rewriteSortComparator(
  arrow: ts.ArrowFunction,
  className: string,
  layout: DenseClassLayout,
): ts.ArrowFunction {
  const f = ts.factory
  const paramNames = new Set<string>()
  for (const p of arrow.parameters) { if (ts.isIdentifier(p.name)) paramNames.add(p.name.text) }

  function rewriteNode(n: ts.Node): ts.Node {
    if (ts.isPropertyAccessExpression(n)) {
      const chain = buildPropertyChain(n)
      if (chain.base && paramNames.has(chain.base) && chain.props.length === 1) {
        const arrName = resolveArrayName(chain.props[0], layout)
        if (arrName) {
          return f.createElementAccessExpression(
            f.createPropertyAccessExpression(f.createIdentifier(className), arrName),
            f.createPropertyAccessExpression(f.createIdentifier(chain.base), '_idx'),
          )
        }
      }
    }
    return ts.visitEachChild(n, rewriteNode, undefined)
  }

  const rewrittenBody = ts.visitNode(arrow.body, rewriteNode)
  const result = f.createArrowFunction(
    arrow.modifiers, arrow.typeParameters, arrow.parameters, arrow.type, arrow.equalsGreaterThanToken, rewrittenBody,
  )
  copyLeadingComments(result, arrow)
  return result
}

// ── Body-rewrite node visitor ──

function idxAccessExpr(f: typeof ts.factory, iterableExpr: ts.Expression): ts.Expression {
  return f.createPropertyAccessExpression(
    f.createElementAccessExpression(iterableExpr, f.createIdentifier('_i')),
    f.createIdentifier('_idx'),
  )
}

function makeRewriteNode(
  f: typeof ts.factory,
  itemName: string,
  layout: DenseClassLayout,
  iterableExpr: ts.Expression,
): { rewriteNode: (n: ts.Node) => ts.Node; usedFields: Set<string>; hasItemRefs: { value: boolean } } {
  const usedFields = new Set<string>()
  const hasItemRefs = { value: false }

  function rewriteNode(n: ts.Node): ts.Node {
    // Property access: node.field → _field[iterableExpr[_i]._idx]
    if (ts.isPropertyAccessExpression(n)) {
      const chain = buildPropertyChain(n)
      if (chain.base === itemName && chain.props.length === 1) {
        const arrName = resolveArrayName(chain.props[0], layout)
        if (arrName) {
          usedFields.add(chain.props[0])
          return f.createElementAccessExpression(
            f.createIdentifier(`_${chain.props[0]}`),
            idxAccessExpr(f, iterableExpr),
          )
        }
      }
    }
    // Compound assignment: node.field op= val → _field[iterableExpr[_i]._idx] op= val
    if (ts.isBinaryExpression(n) && ts.isAssignmentOperator(n.operatorToken) && ts.isPropertyAccessExpression(n.left)) {
      const chain = buildPropertyChain(n.left)
      if (chain.base === itemName && chain.props.length === 1) {
        const arrName = resolveArrayName(chain.props[0], layout)
        if (arrName) {
          usedFields.add(chain.props[0])
          return f.createBinaryExpression(
            f.createElementAccessExpression(f.createIdentifier(`_${chain.props[0]}`), idxAccessExpr(f, iterableExpr)),
            n.operatorToken.kind,
            ts.visitEachChild(n.right, rewriteNode, undefined),
          )
        }
      }
    }
    // Remaining itemName ref → all[_i] (method calls, push args, etc.)
    if (ts.isIdentifier(n) && n.text === itemName) {
      return f.createElementAccessExpression(iterableExpr, f.createIdentifier('_i'))
    }
    return ts.visitEachChild(n, rewriteNode, undefined)
  }

  return { rewriteNode, usedFields, hasItemRefs }
}
