import type { Plugin } from 'vite'
import ts from 'typescript'

// Known types and their slot layout
const DENSE_TYPE_SIZES: Record<string, { slots: number; fieldNames: string[] }> = {
  Vec2:    { slots: 2, fieldNames: ['x', 'y'] },
  Vector2: { slots: 2, fieldNames: ['x', 'y'] },
  Rotation: { slots: 3, fieldNames: ['x', 'y', 'z'] },
}

/** Per-field layout info for a @dense class — shared with @dense_iter */
export interface DenseFieldInfo {
  arrayName: string
  typeName: string
}

/** Full class layout — shared with @dense_iter */
export interface DenseClassLayout {
  fieldCount: number
  fields: Map<string, DenseFieldInfo>
}

/** Registry populated during @dense transforms, consumed by @dense_iter */
export const DENSE_REGISTRY = new Map<string, DenseClassLayout>()

interface DenseField {
  name: string
  typeName: string
  initExpr: ts.Expression | null
  initVal: number
}

const DENSE_MARKER = '@dense'
const BUF_CAP = 1_000_000  // per-field capacity

export function vitePluginDense(): Plugin {
  return {
    name: 'vite-plugin-dense',
    enforce: 'pre',
    transform(code: string, id: string) {
      const [cleanId] = id.split(/[?#]/)
      if (!/\.(ts|tsx)$/.test(cleanId)) return null
      if (!code.includes(DENSE_MARKER)) return null

      let scriptKind = ts.ScriptKind.TS
      if (cleanId.endsWith('.tsx')) scriptKind = ts.ScriptKind.TSX

      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, scriptKind)

      const denseClasses: { classNode: ts.ClassDeclaration; fields: DenseField[]; className: string; shared: boolean }[] = []
      let hasDense = false

      ts.forEachChild(sourceFile, node => {
        if (!ts.isClassDeclaration(node)) return
        if (!hasDenseComment(node, sourceFile)) return

        hasDense = true
        const className = node.name?.text ?? 'Anonymous'
        const shared = isDenseShared(node, sourceFile)
        const fields: DenseField[] = []

        for (const member of node.members) {
          if (!ts.isPropertyDeclaration(member)) continue
          if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue
          if (ts.isIdentifier(member.name) && member.name.text.startsWith('_')) continue

          const propName = member.name.getText(sourceFile)
          const init = member.initializer
          if (!init) continue

          const initVal = resolveInitValue(init)
          if (initVal === null) continue

          fields.push({ name: propName, typeName: 'number', initExpr: init, initVal })
        }

        if (fields.length > 0) {
          denseClasses.push({ classNode: node, fields, className, shared })
        }
      })

      if (!hasDense) return null

      const result = ts.transform(sourceFile, [createDenseTransformer(denseClasses, sourceFile)])
      const tf = result.transformed[0] as ts.SourceFile

      let needsEmit = false
      ts.forEachChild(tf, node => {
        if (ts.isClassDeclaration(node) && node.name) {
          const hasArr = node.members.some(m =>
            ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text.endsWith('_arr')
          )
          if (hasArr) needsEmit = true
        }
      })

      if (!needsEmit) return null

      const printer = ts.createPrinter({ removeComments: false })
      const transformedCode = printer.printFile(tf)
      return { code: transformedCode, map: null }
    },
  }
}

function hasDenseComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text
  const start = node.getFullStart()
  const end = node.getStart(sourceFile)
  const trivia = text.substring(start, end)
  return trivia.includes(DENSE_MARKER)
}

function isDenseShared(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text
  const start = node.getFullStart()
  const end = node.getStart(sourceFile)
  const trivia = text.substring(start, end)
  return /@dense\(shared\)/.test(trivia)
}

function resolveInitValue(init: ts.Expression): number | null {
  if (ts.isNumericLiteral(init)) return Number(init.text)
  if (init.kind === ts.SyntaxKind.TrueKeyword) return 1
  if (init.kind === ts.SyntaxKind.FalseKeyword) return 0
  if (ts.isIdentifier(init)) return 0
  if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.BarToken) {
    // e.g. `1 | 2` → evaluate constant
    const l = resolveInitValue(init.left), r = resolveInitValue(init.right)
    if (l !== null && r !== null) return l | r
  }
  if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.TildeToken) {
    const v = resolveInitValue(init.operand)
    if (v !== null) return ~v
  }
  return null
}

function createDenseTransformer(
  denseClasses: { classNode: ts.ClassDeclaration; fields: DenseField[]; className: string; shared: boolean }[],
  sourceFile: ts.SourceFile,
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    return (rootNode: ts.Node) => {
      function visit(node: ts.Node): ts.Node {
        if (ts.isClassDeclaration(node) && node.name) {
          const match = denseClasses.find(dc => dc.className === node.name!.text)
          if (match) return buildDenseClass(node, match, sourceFile)
        }
        return ts.visitEachChild(node, visit, context)
      }
      return ts.visitNode(rootNode, visit)
    }
  }
}

function arrName(fieldName: string) { return `_${fieldName}_arr` }

function buildDenseClass(
  originalClass: ts.ClassDeclaration,
  dense: { className: string; fields: DenseField[]; shared: boolean },
  sourceFile: ts.SourceFile,
): ts.ClassDeclaration {
  const className = dense.className
  const fieldCount = dense.fields.length
  const f = ts.factory

  const keptMembers: ts.ClassElement[] = []
  for (const member of originalClass.members) {
    if (!ts.isPropertyDeclaration(member)) {
      keptMembers.push(member)
      continue
    }
    if (member.name && ts.isIdentifier(member.name)) {
      if (!dense.fields.find(df => df.name === member.name!.text)) {
        keptMembers.push(member)
      }
    } else {
      keptMembers.push(member)
    }
  }

  // _idx instance field
  const idxField = f.createPropertyDeclaration(
    [f.createModifier(ts.SyntaxKind.PublicKeyword)],
    '_idx', undefined, undefined,
    f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(1)),
  )

  // Static _buf — one large Int32Array (optionally SharedArrayBuffer-backed)
  const bufSize = BUF_CAP * fieldCount
  const bufInit = dense.shared
    ? f.createNewExpression(
        f.createIdentifier('Int32Array'), undefined,
        [f.createNewExpression(f.createIdentifier('SharedArrayBuffer'), undefined,
          [f.createNumericLiteral(bufSize * 4)])])
    : f.createNewExpression(
        f.createIdentifier('Int32Array'), undefined,
        [f.createNumericLiteral(bufSize)])
  const staticBuf = f.createPropertyDeclaration(
    [f.createModifier(ts.SyntaxKind.StaticKeyword)],
    '_buf', undefined, undefined,
    bufInit,
  )

  const staticCount = f.createPropertyDeclaration(
    [f.createModifier(ts.SyntaxKind.StaticKeyword)],
    '_count', undefined, undefined,
    f.createNumericLiteral(0),
  )

  const staticFree = f.createPropertyDeclaration(
    [f.createModifier(ts.SyntaxKind.StaticKeyword)],
    '_free', undefined, undefined,
    f.createAsExpression(
      f.createArrayLiteralExpression([]),
      f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    ),
  )

  // Per-field subarray views: _fieldName_arr = _buf.subarray(off, off + BUF_CAP)
  const fieldArrays: ts.ClassElement[] = []
  for (let i = 0; i < fieldCount; i++) {
    const fn = dense.fields[i].name
    const off = i * BUF_CAP
    fieldArrays.push(
      f.createPropertyDeclaration(
        [f.createModifier(ts.SyntaxKind.StaticKeyword)],
        arrName(fn), undefined, undefined,
        f.createCallExpression(
          f.createPropertyAccessExpression(
            f.createPropertyAccessExpression(f.createIdentifier(className), '_buf'), 'subarray'),
          undefined,
          [f.createNumericLiteral(off), f.createNumericLiteral(off + BUF_CAP)],
        ),
      ),
    )
  }

  // ── Constructor ──
  const ctorStmts: ts.Statement[] = []

  // Allocate _idx
  const allocStmt = f.createIfStatement(
    f.createBinaryExpression(
      f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createIdentifier(className), '_free'), 'length'),
      ts.SyntaxKind.GreaterThanToken,
      f.createNumericLiteral(0),
    ),
    f.createExpressionStatement(
      f.createBinaryExpression(
        f.createPropertyAccessExpression(f.createThis(), '_idx'),
        ts.SyntaxKind.EqualsToken,
        f.createCallExpression(
          f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createIdentifier(className), '_free'), 'pop'),
          undefined, [],
        ),
      ),
    ),
    f.createExpressionStatement(
      f.createBinaryExpression(
        f.createPropertyAccessExpression(f.createThis(), '_idx'),
        ts.SyntaxKind.EqualsToken,
        f.createPostfixIncrement(f.createPropertyAccessExpression(f.createIdentifier(className), '_count')),
      ),
    ),
  )
  ctorStmts.push(allocStmt)

  // Init each field in its array
  const idx = f.createPropertyAccessExpression(f.createThis(), '_idx')
  for (const field of dense.fields) {
    ctorStmts.push(
      f.createExpressionStatement(
        f.createBinaryExpression(
          f.createElementAccessExpression(
            f.createPropertyAccessExpression(f.createIdentifier(className), arrName(field.name)),
            idx,
          ),
          ts.SyntaxKind.EqualsToken,
          f.createNumericLiteral(field.initVal),
        ),
      ),
    )
  }

  const ctor = f.createConstructorDeclaration(undefined, [], f.createBlock(ctorStmts, true))

  // ── Raw accessor per field ──
  const rawAccessors: ts.ClassElement[] = []
  for (const field of dense.fields) {
    const aName = arrName(field.name)
    const bufRef = f.createPropertyAccessExpression(f.createIdentifier(className), aName)

    rawAccessors.push(
      f.createMethodDeclaration(
        undefined, undefined,
        f.createIdentifier(`_${field.name}`),
        undefined, undefined,
        [f.createParameterDeclaration(undefined, undefined, f.createIdentifier('_v'), undefined, undefined, undefined)],
        undefined,
        f.createBlock([
          f.createIfStatement(
            f.createBinaryExpression(
              f.createIdentifier('_v'),
              ts.SyntaxKind.EqualsEqualsEqualsToken,
              f.createVoidExpression(f.createNumericLiteral(0)),
            ),
            f.createBlock([
              f.createReturnStatement(f.createElementAccessExpression(bufRef, f.createPropertyAccessExpression(f.createThis(), '_idx'))),
            ]),
            f.createBlock([
              f.createExpressionStatement(
                f.createBinaryExpression(
                  f.createElementAccessExpression(bufRef, f.createPropertyAccessExpression(f.createThis(), '_idx')),
                  ts.SyntaxKind.EqualsToken,
                  f.createIdentifier('_v'),
                ),
              ),
              f.createReturnStatement(f.createElementAccessExpression(bufRef, f.createPropertyAccessExpression(f.createThis(), '_idx'))),
            ]),
          ),
        ]),
      ),
    )
  }

  // ── Dispose ──
  const disposeMethod = f.createMethodDeclaration(
    undefined, undefined,
    f.createIdentifier('dispose'),
    undefined, undefined, [],
    undefined,
    f.createBlock([
      f.createExpressionStatement(
        f.createCallExpression(
          f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createIdentifier(className), '_free'), 'push'),
          undefined,
          [f.createPropertyAccessExpression(f.createThis(), '_idx')],
        ),
      ),
      f.createExpressionStatement(
        f.createBinaryExpression(
          f.createPropertyAccessExpression(f.createThis(), '_idx'),
          ts.SyntaxKind.EqualsToken,
          f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(1)),
        ),
      ),
    ]),
  )

  // ── Getters/setters for API compat ──
  const apiMembers: ts.ClassElement[] = []
  for (const field of dense.fields) {
    const rawName = `_${field.name}`
    apiMembers.push(
      f.createGetAccessorDeclaration(undefined, f.createIdentifier(field.name), undefined, undefined,
        f.createBlock([
          f.createReturnStatement(
            f.createCallExpression(f.createPropertyAccessExpression(f.createThis(), rawName), undefined, []),
          ),
        ]),
      ),
    )
    apiMembers.push(
      f.createSetAccessorDeclaration(undefined, f.createIdentifier(field.name),
        [f.createParameterDeclaration(undefined, undefined, f.createIdentifier('_v'), undefined, undefined, undefined)],
        f.createBlock([
          f.createExpressionStatement(
            f.createCallExpression(f.createPropertyAccessExpression(f.createThis(), rawName), undefined, [f.createIdentifier('_v')]),
          ),
        ]),
      ),
    )
  }

  // ── Assemble ──
  const hasOwnDispose = keptMembers.some(m =>
    ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'dispose'
  )
  const allMembers: ts.ClassElement[] = [
    staticBuf,
    staticCount,
    staticFree,
    ...fieldArrays,
    idxField,
    ctor,
    ...rawAccessors,
    ...(hasOwnDispose ? [] : [disposeMethod]),
    ...apiMembers,
    ...keptMembers,
  ]

  const result = f.createClassDeclaration(
    originalClass.modifiers?.filter(m => !ts.isDecorator(m)),
    originalClass.name,
    originalClass.typeParameters,
    originalClass.heritageClauses,
    allMembers,
  )

  // Register layout
  const regFields = new Map<string, DenseFieldInfo>()
  for (const fld of dense.fields) {
    regFields.set(fld.name, { arrayName: arrName(fld.name), typeName: fld.typeName })
  }
  DENSE_REGISTRY.set(className, { fieldCount, fields: regFields })

  return result
}

/**
 * Shared — scan a source file for a @dense class and compute its field layout.
 */
export function scanDenseClassLayout(source: string, className: string): DenseClassLayout | null {
  const sourceFile = ts.createSourceFile('inline.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let result: DenseClassLayout | null = null

  ts.forEachChild(sourceFile, node => {
    if (!ts.isClassDeclaration(node)) return
    if (node.name?.text !== className) return
    if (!hasDenseComment(node, sourceFile)) return

    const fields = new Map<string, DenseFieldInfo>()

    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue
      if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue
      if (member.name && ts.isIdentifier(member.name) && member.name.text.startsWith('_')) continue

      const init = member.initializer
      if (!init) continue

      const initVal = resolveInitValue(init)
      if (initVal === null) continue

      const propName = member.name!.getText(sourceFile)
      fields.set(propName, { arrayName: arrName(propName), typeName: 'number' })
    }

    if (fields.size > 0) {
      result = { fieldCount: fields.size, fields }
    }
  })

  return result
}
