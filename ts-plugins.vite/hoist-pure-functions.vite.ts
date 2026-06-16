import ts from "typescript"

export function tsClosureHoisterPlugin() {
  return {
    name: "vite-plugin-ultimate-hoist",
    transform(code: string, id: string) {
      if (!id.endsWith(".ts") && !id.endsWith(".tsx") && !id.endsWith(".js")) return null

      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true)
      const globalHoists: ts.ArrowFunction[] = []
      // removeComments:true strips @hoist artifacts that TS 6.x printer doubles
      // on single-param arrow functions (child => ...). Detection still works
      // because hasHoistComment reads the source text before printing.
      const printer = ts.createPrinter({ removeComments: true })

      // Track local block hoists
      const localHoistsMap = new Map<ts.Block, { id: string; node: ts.Node }[]>()
      let hoistCounter = 0

      const transformer = (context: ts.TransformationContext) => {
        return (rootNode: ts.Node) => {
          function visit(node: ts.Node): ts.Node {
            if (ts.isArrowFunction(node) && hasHoistComment(node, sourceFile)) {
              const uId = hoistCounter++
              const hasThis = containsThisKeyword(node)

              // Find variables captured from parent scopes (excluding globals)
              const capturedVars = findCapturedIdentifiers(node)

              // CASE A: Closure captures local parent variables -> Must stay in local blocks
              if (capturedVars.length > 0) {
                const nearestBlock = findNearestParentBlock(node)
                if (nearestBlock) {
                  const localId = `_localHoist$${uId}`
                  if (!localHoistsMap.has(nearestBlock)) localHoistsMap.set(nearestBlock, [])

                  localHoistsMap.get(nearestBlock)!.push({
                    id: localId,
                    node: node
                  })
                  return ts.factory.createIdentifier(localId)
                }
              }

              // CASE B: Closure only captures 'this' -> Global Lazy-Binding
              if (hasThis) {
                const index = globalHoists.length
                globalHoists.push(node)

                const bakedRef = ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier("JS.Baked"),
                  ts.factory.createIdentifier(`$${index}`)
                )
                const cacheProp = ts.factory.createPropertyAccessExpression(
                  ts.factory.createThis(),
                  ts.factory.createIdentifier(`_baked$${index}`)
                )
                const bindCall = ts.factory.createCallExpression(
                  ts.factory.createPropertyAccessExpression(bakedRef, ts.factory.createIdentifier("bind")),
                  undefined,
                  [ts.factory.createThis()]
                )
                return ts.factory.createBinaryExpression(
                  cacheProp,
                  ts.SyntaxKind.BarBarToken,
                  ts.factory.createParenthesizedExpression(ts.factory.createAssignment(cacheProp, bindCall))
                )
              }

              // CASE C: Completely Pure -> Pure Global Hoist
              const index = globalHoists.length
              globalHoists.push(node)
              return ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier("JS.Baked"),
                ts.factory.createIdentifier(`$${index}`)
              )
            }

            // Only descend if this subtree contains @hoist — avoids creating AST clones
            // that trigger a TS 6.x printer bug: comments on single-param arrow functions
            // get doubled when removeComments: false.
            if (sourceFile.text.substring(node.getFullStart(), node.end).includes('@hoist')) {
              const visitedNode = ts.visitEachChild(node, visit, context)
              if (ts.isBlock(visitedNode) && localHoistsMap.has(node as ts.Block)) {
                const hoists = localHoistsMap.get(node as ts.Block)!
                const declarations = hoists.map(/*@hoist*/({ id, node }) => {
                  return ts.factory.createVariableStatement(
                    undefined,
                    ts.factory.createVariableDeclarationList(
                      [ts.factory.createVariableDeclaration(id, undefined, undefined, node as ts.Expression)],
                      ts.NodeFlags.Const
                    )
                  )
                })
                return ts.factory.updateBlock(visitedNode, [...declarations, ...visitedNode.statements])
              }
              return visitedNode
            }
            return node
          }
          return ts.visitNode(rootNode, visit)
        }
      }

      const result = ts.transform(sourceFile, [transformer])
      let transformedCode = printer.printFile(result.transformed[0] as ts.SourceFile)

      // Inject global container if needed
      if (globalHoists.length > 0) {
        const bakedMethods = globalHoists
          .map(/*@hoist*/(fn, i) => {
            const params = fn.parameters.map(p => printer.printNode(ts.EmitHint.Unspecified, p, sourceFile)).join(", ")
            let body = printer.printNode(ts.EmitHint.Unspecified, fn.body, sourceFile)
            if (!ts.isBlock(fn.body)) body = `{ return ${body}; }`
            return `  $${i}(${params}) ${body},`
          })
          .join("\n")

        transformedCode = `\nconst JS = { Baked: {\n${bakedMethods}\n} };\n` + transformedCode
      }

      return { code: transformedCode, map: null }
    }
  }
}

// AST Helpers
function containsThisKeyword(node: ts.Node): boolean {
  let hasThis = false
  function walk(child: ts.Node) {
    if (child.kind === ts.SyntaxKind.ThisKeyword) { hasThis = true; return }
    if (ts.isFunctionDeclaration(child) || ts.isFunctionExpression(child) || ts.isClassDeclaration(child)) return
    ts.forEachChild(child, walk)
  }
  ts.forEachChild(node, walk)
  return hasThis
}

function findCapturedIdentifiers(arrowFn: ts.ArrowFunction): string[] {
  const declaredInside = new Set<string>()
  const usedIdentifiers = new Set<string>()

  // Track parameter definitions inside the closure
  arrowFn.parameters.forEach(/*@hoist*/ p => {
    if (ts.isIdentifier(p.name)) declaredInside.add(p.name.text)
  })

  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declaredInside.add(node.name.text)
    }
    if (ts.isIdentifier(node)) {
      // Avoid tracking property access keys (e.g., node.box -> ignore 'box')
      if (!(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
        usedIdentifiers.add(node.text)
      }
    }
    ts.forEachChild(node, walk)
  }

  ts.forEachChild(arrowFn.body, walk)

  // Filter out internal declarations and common global runtimes
  const nativeGlobals = new Set(["console", "Math", "Date", "Array", "Object", "Error", "window", "document", "true", "false"])
  return Array.from(usedIdentifiers).filter(/*@hoist*/ id => !declaredInside.has(id) && !nativeGlobals.has(id))
}

function findNearestParentBlock(node: ts.Node): ts.Block | null {
  let current = node.parent
  while (current) {
    if (ts.isBlock(current)) return current
    current = current.parent
  }
  return null
}

function hasHoistComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const fileText = sourceFile.text
  const comments = ts.getLeadingCommentRanges(fileText, node.pos)
  if (comments) {
    for (const comment of comments) {
      if (fileText.substring(comment.pos, comment.end).includes("@hoist")) return true
    }
  }
  const syntheticComments = ts.getSyntheticLeadingComments(node)
  if (syntheticComments) {
    for (const comment of syntheticComments) {
      if (comment.text.includes("@hoist")) return true
    }
  }
  return false
}
