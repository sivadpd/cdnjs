'use strict'

const globalExpressions = function() {
  let expressions = new Map
  let value = (0, eval)('this')
  let object = {
    type: 'CallExpression',
    callee: {
      type: 'SequenceExpression',
      expressions: [
        {type: 'Literal', value: 0},
        {type: 'Identifier', name: 'eval'}
      ]
    },
    arguments: [{type: 'Literal', value: 'this'}]
  }

  return crawl(expressions, value, object)

  function crawl(expressions, value, object) {
    if (Object(value) !== value) return

    if (expressions.has(value)) return

    expressions.set(value, object)

    Object.getOwnPropertyNames(value).forEach(function(name) {
      let descriptor = Object.getOwnPropertyDescriptor(value, name)
      let property = {type: 'Identifier', name}

      if (object) property = {type: 'MemberExpression', object, property}

      crawl(expressions, descriptor.value, property)
    })

    return expressions
  }
}()

const nativeCode = String(Object).match(/{.*/)[0]
function isNativeFunction(fn) {
  let source = String(fn)
  let index = source.indexOf(nativeCode)
  if (index < 0) return false

  let length = index + nativeCode.length
  return length === source.length
}

export default function(value, options) {
  if (!options) options = {}

  const expressions = new Map(globalExpressions)
  const functions = new Set
  const placeholder = Math.random().toString(36).replace(/../, '_')
  const functionPattern = RegExp(`${placeholder}(\\d+)`, 'g')
  const statements = []
  const statement = {
    type: options.type || 'ExpressionStatement'
  }

  const parse = options.parse
  const generate = options.generate
  if (!parse && !generate) {
    throw new Error(`One of 'parse' or 'generate' must be specified.`)
  }

  switch (statement.type) {
    case 'ExpressionStatement':
      statement.expression = expression(value)
      break

    case 'ExportDefaultDeclaration':
      statement.declaration = expression(value)
      break

    default:
      throw new Error(`Unsupported type: ${statement.type}`)
  }

  statements.push(statement)

  statements.unshift({
    type: 'VariableDeclaration',
    declarations: declarations(statements),
    kind: 'const'
  })

  const program = {type: 'Program', body: statements}
  const code = generate(program)

  return code.replace(functionPattern, (_, i) => Array.from(functions)[i])

  function declarations(statements) {
    const sites = new Map

    statements.forEach(function crawl(value, key, object) {
      if (Object(value) !== value) return

      let valueSites = sites.get(value)
      if (valueSites) return valueSites.push({object, key})

      sites.set(value, [{object, key}])

      for (let property in value) {
        crawl(value[property], property, value)
      }
    })

    let declarations = Array.from(sites)
      .filter(entry => entry[1].length > 1)
      .map((entry, index) => {
        let id = {type: 'Identifier'}
        for (let site of entry[1]) site.object[site.key] = id

        return {type: 'VariableDeclarator', id, init: entry[0]}
      })

    declarations
      .sort((a, b) => has(a.init, b.id) - has(b.init, a.id))
      .forEach((declaration, i) => declaration.id.name = '$' + i)

    return declarations
  }

  function has(parent, child) {
    if (parent === child) return true

    if (Object(parent) !== parent) return false

    for (let key in parent) {
      if (has(parent[key], child)) return true
    }

    return false
  }

  function expression(value) {
    switch (typeof value) {
      case 'undefined':
        return {type: 'Identifier', name: 'undefined'}

      case 'object': if (value !== null) break
      case 'string':
      case 'number':
      case 'boolean':
        return {type: 'Literal', value}
    }

    if (expressions.has(value)) return expressions.get(value)

    const object = {}
    expressions.set(value, object)

    const names = Object.getOwnPropertyNames(value)
    if (value instanceof String) names.splice(0, value.length)

    const descriptors = new Map(names.map(name =>
      [name, Object.getOwnPropertyDescriptor(value, name)]
    ))

    const proto = Object.getPrototypeOf(value)
    switch (proto) {
      case String.prototype: descriptors.delete('length')
      case Number.prototype:
      case Boolean.prototype:
      case Date.prototype:
        object.type = 'NewExpression'
        object.callee = expression(value.constructor)
        object.arguments = [expression(value.valueOf())]
        break

      case RegExp.prototype:
        descriptors.delete('source')
        descriptors.delete('global')
        descriptors.delete('ignoreCase')
        descriptors.delete('multiline')
        descriptors.delete('lastIndex')
        object.type = 'Literal'
        object.value = value
        break

      case Buffer.prototype:
        object.type = 'NewExpression'
        object.callee = expression(Buffer)
        object.arguments = [value.toString("base64"), "base64"].map(expression)
        break

      case Function.prototype:
        if (isNativeFunction(value)) {
          throw new Error('Native code cannot be serialized.')
        }

        functions.add(value)
        let index = Array.from(functions).indexOf(value)
        descriptors.delete('length')
        descriptors.delete('name')
        descriptors.delete('arguments')
        descriptors.delete('caller')
        descriptors.delete('prototype')
        object.type = 'Identifier'
        object.name = placeholder + index
        break

      case Error.prototype:
      case EvalError.prototype:
      case RangeError.prototype:
      case ReferenceError.prototype:
      case SyntaxError.prototype:
      case TypeError.prototype:
      case URIError.prototype:
        descriptors.delete('message')
        if (!value.stack) descriptors.delete('stack')

        object.type = 'NewExpression'
        object.callee = expression(value.constructor)
        object.arguments = [expression(value.message)]
        break

      case Array.prototype:
        descriptors.delete('length')

        if (value.filter(x => true).length < value.length) {
          object.type = 'CallExpression'
          object.callee = expression(value.constructor)
          object.arguments = [expression(value.length)]
        }

        else {
          object.type = 'ArrayExpression'
          object.elements = value.map((item, index) => {
            let element = expression(item)

            if (element === object) element = expression(null)
            else descriptors.delete(String(index))

            return element
          })
        }

        break

      case Object.prototype:
        object.type = 'ObjectExpression'
        object.properties = []

        for (let pair of descriptors) {
          // handle method / getter / setter shorthand
          descriptors.delete(pair[0])
          object.properties.push({
            type: 'Property',
            key: expression(pair[0]),
            value: expression(pair[1].value)
          })
        }

        break

      default:
        object.type = 'CallExpression'
        object.callee = expression(Object.create)
        object.arguments = [expression(proto)]
        break
    }

    for (let pair of descriptors) {
      let computed = !isNaN(pair[0])
      let property = computed
        ? expression(Number(pair[0]))
        : {type: 'Identifier', name: pair[0]}

      statements.push({
        type: 'ExpressionStatement',
        expression: {
          type: 'AssignmentExpression',
          operator: '=',
          left: {type: 'MemberExpression', computed, object, property},
          right: expression(pair[1].value)
        }
      })
    }

    return object
  }
}