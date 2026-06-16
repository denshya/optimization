import type { Plugin } from 'vite'
import ts from 'typescript'

const TYPE_MAP: Record<string, string> = {
  int32: 'Int32Array',
  uint32: 'Uint32Array',
  int16: 'Int16Array',
  uint16: 'Uint16Array',
  int8: 'Int8Array',
  uint8: 'Uint8Array',
  float32: 'Float32Array',
  float64: 'Float64Array',
}

interface TypedField {
  name: string
  index: number
  isCtorParam: boolean
  initVal: number | null
}

interface TypedClassInfo {
  className: string
  arrayType: string
  fields: TypedField[]
}

export function vitePluginTypedClass(): Plugin {
  return {
    name: 'vite-plugin-typed-class',
    enforce: 'pre',
    transform(code: string, id: string) {
      const [cleanId] = id.split(/[?#]/)
      if (!/\.(ts|tsx)$/.test(cleanId)) return null

      if (!Object.keys(TYPE_MAP).some(key => code.includes(`@${key}`))) return null

      let scriptKind = ts.ScriptKind.TS
      if (cleanId.endsWith('.tsx')) scriptKind = ts.ScriptKind.TSX

      const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, scriptKind)

      const classes: TypedClassInfo[] = []

      ts.forEachChild(sourceFile, node => {
        if (!ts.isClassDeclaration(node)) return
        const typeName = getTypeAnnotation(node, sourceFile)
        if (!typeName) return
        const arrayType = TYPE_MAP[typeName]
        if (!arrayType) return
        const className = node.name?.text ?? 'Anonymous'
        const fields = collectTypedFields(node)
        if (fields.length === 0) return
        classes.push({ className, arrayType, fields })
      })

      const result = ts.transform(sourceFile, [
        // 1. Transform class bodies (typed arrays, getters/setters, this.x → this.buf[i])
        () => (rootNode: ts.Node) => {
          function visit(node: ts.Node): ts.Node {
            if (ts.isClassDeclaration(node) && node.name) {
              const info = classes.find(c => c.className === node.name!.text)
              if (info) return buildTypedClass(node, info)
            }
            return ts.visitEachChild(node, visit, undefined)
          }
          return ts.visitNode(rootNode, visit)
        },
        // 2. Transform `/*@type*/ new ClassName(args)` → append buf argument
        () => (rootNode: ts.Node) => {
          const f = ts.factory
          function visit(node: ts.Node): ts.Node {
            if (
              ts.isNewExpression(node) &&
              node.pos >= 0 &&
              ts.isIdentifier(node.expression)
            ) {
              const overrideType = getNewExprPragma(node, sourceFile)
              if (overrideType) {
                const arrayName = TYPE_MAP[overrideType]
                if (arrayName) {
                  const className = node.expression.text
                  const args = node.arguments ? [...node.arguments] : []
                  const info = classes.find(c => c.className === className)
                  const bufSize = info ? info.fields.length : Math.max(args.length, 1)
                  const bufArg = f.createNewExpression(
                    f.createIdentifier(arrayName), undefined,
                    [f.createNumericLiteral(bufSize)],
                  )
                  return f.updateNewExpression(node, node.expression, node.typeArguments, [...args, bufArg])
                }
              }
            }
            return ts.visitEachChild(node, visit, undefined)
          }
          return ts.visitNode(rootNode, visit)
        },
      ])

      const printer = ts.createPrinter({ removeComments: false })
      const transformedCode = printer.printFile(result.transformed[0] as ts.SourceFile)
      return { code: transformedCode, map: null }
    },
  }
}

function getTypeAnnotation(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const trivia = sourceFile.text.substring(node.getFullStart(), node.getStart(sourceFile))
  for (const key of Object.keys(TYPE_MAP)) {
    if (new RegExp(`@${key}\\b`).test(trivia)) return key
  }
  return null
}

function getNewExprPragma(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const trivia = sourceFile.text.substring(node.getFullStart(), node.getStart(sourceFile))
  // Match block-comment pragmas: /*@int32*/  or  /** @int32 */
  for (const key of Object.keys(TYPE_MAP)) {
    if (new RegExp(`@${key}\\b`).test(trivia)) return key
  }
  return null
}

function collectTypedFields(classNode: ts.ClassDeclaration): TypedField[] {
  const fields: TypedField[] = []
  const seen = new Set<string>()
  let index = 0

  for (const member of classNode.members) {
    if (!ts.isConstructorDeclaration(member)) continue
    for (const param of member.parameters) {
      const hasMod = param.modifiers?.some(m =>
        m.kind === ts.SyntaxKind.PublicKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword ||
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ReadonlyKeyword
      )
      if (!hasMod) continue
      const name = param.name.getText()
      if (!seen.has(name) && !name.startsWith('_')) {
        seen.add(name)
        const initVal = param.initializer ? resolveNumericValue(param.initializer) : null
        fields.push({ name, index: index++, isCtorParam: true, initVal })
      }
    }
  }

  for (const member of classNode.members) {
    if (!ts.isPropertyDeclaration(member)) continue
    if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue
    if (!ts.isIdentifier(member.name)) continue
    const name = member.name.text
    if (name.startsWith('_') || seen.has(name)) continue

    if (!isTypedFieldCandidate(member)) continue
    seen.add(name)
    const initVal = member.initializer ? resolveNumericValue(member.initializer) : null
    fields.push({ name, index: index++, isCtorParam: false, initVal })
  }

  return fields
}

function isTypedFieldCandidate(member: ts.PropertyDeclaration): boolean {
  if (member.type && member.type.kind !== ts.SyntaxKind.NumberKeyword) return false
  if (member.initializer) {
    return resolveNumericValue(member.initializer) !== null
  }
  return true
}

function resolveNumericValue(init: ts.Expression): number | null {
  if (ts.isNumericLiteral(init)) return Number(init.text)
  if (init.kind === ts.SyntaxKind.TrueKeyword) return 1
  if (init.kind === ts.SyntaxKind.FalseKeyword) return 0
  if (ts.isIdentifier(init)) return 0
  if (ts.isPrefixUnaryExpression(init) && init.operator === ts.SyntaxKind.TildeToken) {
    const v = resolveNumericValue(init.operand)
    if (v !== null) return ~v
  }
  if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.BarToken) {
    const l = resolveNumericValue(init.left)
    const r = resolveNumericValue(init.right)
    if (l !== null && r !== null) return l | r
  }
  return null
}

function buildTypedClass(
  original: ts.ClassDeclaration,
  info: TypedClassInfo,
): ts.ClassDeclaration {
  const f = ts.factory
  const fieldNames = new Set(info.fields.map(fd => fd.name))
  const fieldIndex = new Map(info.fields.map(fd => [fd.name, fd.index]))

  const bufAccessAt = (idx: number) =>
    f.createElementAccessExpression(
      f.createNewExpression(
        f.createIdentifier('Float32Array'),
        undefined,
        [f.createPropertyAccessExpression(
          f.createPropertyAccessExpression(f.createThis(), 'buf'),
          f.createIdentifier('buffer'),
        )],
      ),
      f.createNumericLiteral(idx),
    )

  // ── Separate members: keep non-field members, drop managed fields ──
  const keptMembers: ts.ClassElement[] = []
  const staticMemberNames = new Set<string>()
  let oldCtor: ts.ConstructorDeclaration | undefined

  for (const member of original.members) {
    if (ts.isConstructorDeclaration(member)) {
      oldCtor = member
      continue
    }
    if (
      ts.isPropertyDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      if (
        member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) &&
        ts.isIdentifier(member.name)
      ) {
        staticMemberNames.add(member.name.text)
      }
    }
    if (ts.isPropertyDeclaration(member)) {
      if (member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) {
        keptMembers.push(member)
        continue
      }
      if (ts.isIdentifier(member.name) && fieldNames.has(member.name.text)) continue
      keptMembers.push(member)
      continue
    }
    keptMembers.push(member)
  }

  // ── `this.buf` → `this.buf[idx]` rewriter ──
  const rewriteThisAccess = (node: ts.Node): ts.Node => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(node.name)
    ) {
      const idx = fieldIndex.get(node.name.text)
      if (idx !== undefined) return bufAccessAt(idx)
    }
    return ts.visitEachChild(node, rewriteThisAccess, undefined)
  }

  // ── Shared type helpers ──
  const allArrayTypes = Object.values(TYPE_MAP).map(t =>
    f.createTypeReferenceNode(f.createIdentifier(t), undefined),
  )
  const bufType = f.createUnionTypeNode(allArrayTypes)

  const bufParamType = f.createUnionTypeNode(allArrayTypes)

  const buildBufParam = () =>
    f.createParameterDeclaration(
      undefined, undefined,
      f.createIdentifier('buf'),
      undefined,
      bufParamType,
      f.createNewExpression(
        f.createIdentifier(info.arrayType), undefined,
        [f.createNumericLiteral(info.fields.length)],
      ),
    )

  const buildAssignBufStmt = () =>
    f.createExpressionStatement(
      f.createBinaryExpression(
        f.createPropertyAccessExpression(f.createThis(), 'buf'),
        ts.SyntaxKind.EqualsToken,
        f.createIdentifier('buf'),
      ),
    )

  const buildAccessors = (): ts.ClassElement[] => {
    const accessors: ts.ClassElement[] = []
    for (const fd of info.fields) {
      const buf = bufAccessAt(fd.index)
      accessors.push(
        f.createGetAccessorDeclaration(
          undefined,
          f.createIdentifier(fd.name),
          [],
          f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          f.createBlock([f.createReturnStatement(buf)]),
        ),
      )
      accessors.push(
        f.createSetAccessorDeclaration(
          undefined,
          f.createIdentifier(fd.name),
          [f.createParameterDeclaration(
            undefined, undefined,
            f.createIdentifier('_v'),
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            undefined,
          )],
          f.createBlock([
            f.createExpressionStatement(
              f.createBinaryExpression(buf, ts.SyntaxKind.EqualsToken, f.createIdentifier('_v')),
            ),
          ]),
        ),
      )
    }
    return accessors
  }

  // ── buf instance field (no initializer, wide union type) ──
  const bufField = f.createPropertyDeclaration(
    undefined,
    f.createIdentifier('buf'),
    undefined,
    bufType,
    undefined,
  )

  // ── Static factory methods ──
  const buildStaticFactories = (userParams: ts.ParameterDeclaration[]): ts.ClassElement[] => {
    const methods: ts.ClassElement[] = []
    for (const [typeName, arrayName] of Object.entries(TYPE_MAP)) {
      if (staticMemberNames.has(typeName)) continue

      const sigParams = userParams.map(p =>
        f.createParameterDeclaration(
          undefined, undefined,
          p.name,
          undefined,
          p.type,
          p.initializer,
        ),
      )
      const refs = userParams.map(p => {
        if (ts.isIdentifier(p.name)) return f.createIdentifier(p.name.text)
        return f.createIdentifier('void')
      })

      methods.push(
        f.createMethodDeclaration(
          [f.createModifier(ts.SyntaxKind.StaticKeyword)],
          undefined,
          f.createIdentifier(typeName),
          undefined, undefined,
          sigParams,
          undefined,
          f.createBlock([
            f.createReturnStatement(
              f.createNewExpression(
                f.createIdentifier(info.className), undefined,
                [
                  ...refs,
                  f.createNewExpression(
                    f.createIdentifier(arrayName), undefined,
                    [f.createNumericLiteral(info.fields.length)],
                  ),
                ],
              ),
            ),
          ]),
        ),
      )
    }
    return methods
  }

  // ── Constructor branch ──
  if (oldCtor) {
    const userParams: ts.ParameterDeclaration[] = []
    const ctorInitStmts: ts.Statement[] = []

    for (const param of oldCtor.parameters) {
      const isProp = param.modifiers?.some(m =>
        m.kind === ts.SyntaxKind.PublicKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword ||
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ReadonlyKeyword
      )
      if (isProp) {
        const name = param.name.getText()
        const idx = fieldIndex.get(name)
        if (idx !== undefined) {
          ctorInitStmts.push(
            f.createExpressionStatement(
              f.createBinaryExpression(
                bufAccessAt(idx),
                ts.SyntaxKind.EqualsToken,
                f.createIdentifier(name),
              ),
            ),
          )
          userParams.push(
            f.createParameterDeclaration(
              undefined, undefined,
              param.name,
              undefined,
              param.type,
              param.initializer,
            ),
          )
        } else {
          userParams.push(param)
        }
      } else {
        userParams.push(param)
      }
    }

    for (const fd of info.fields) {
      if (!fd.isCtorParam && fd.initVal !== null) {
        ctorInitStmts.push(
          f.createExpressionStatement(
            f.createBinaryExpression(
              bufAccessAt(fd.index),
              ts.SyntaxKind.EqualsToken,
              f.createNumericLiteral(fd.initVal),
            ),
          ),
        )
      }
    }

    const origBodyStmts = oldCtor.body
      ? oldCtor.body.statements.map(s => ts.visitNode(s, rewriteThisAccess) as ts.Statement)
      : []

    const newCtor = f.createConstructorDeclaration(
      undefined,
      [...userParams, buildBufParam()],
      f.createBlock(
        [buildAssignBufStmt(), ...ctorInitStmts, ...origBodyStmts],
        true,
      ),
    )

    const rewrittenMembers = keptMembers.map(m =>
      ts.visitNode(m, rewriteThisAccess) as ts.ClassElement,
    )

    return f.createClassDeclaration(
      original.modifiers?.filter(m => !ts.isDecorator(m)),
      original.name,
      original.typeParameters,
      original.heritageClauses,
      [
        bufField,
        newCtor,
        ...buildAccessors(),
        ...buildStaticFactories(userParams),
        ...rewrittenMembers,
      ],
    )
  }

  // ── No original constructor: generate one ──
  const bodyStmts: ts.Statement[] = []
  for (const fd of info.fields) {
    if (fd.initVal !== null) {
      bodyStmts.push(
        f.createExpressionStatement(
          f.createBinaryExpression(
            bufAccessAt(fd.index),
            ts.SyntaxKind.EqualsToken,
            f.createNumericLiteral(fd.initVal),
          ),
        ),
      )
    }
  }

  const syntheticCtor = f.createConstructorDeclaration(
    undefined,
    [buildBufParam()],
    f.createBlock([buildAssignBufStmt(), ...bodyStmts], true),
  )

  const rewrittenMembers = keptMembers.map(m =>
    ts.visitNode(m, rewriteThisAccess) as ts.ClassElement,
  )

  return f.createClassDeclaration(
    original.modifiers?.filter(m => !ts.isDecorator(m)),
    original.name,
    original.typeParameters,
    original.heritageClauses,
    [
      bufField,
      syntheticCtor,
      ...buildAccessors(),
      ...buildStaticFactories([]),
      ...rewrittenMembers,
    ],
  )
}
