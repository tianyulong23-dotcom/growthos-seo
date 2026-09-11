import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import prettier from "prettier"

const sourceUrl = new URL(
  "../../backend/contracts/openapi/platform.v1.json",
  import.meta.url
)
const requestedModule =
  process.argv
    .find((argument) => argument.startsWith("--module="))
    ?.slice("--module=".length) ?? "backlinks"
const moduleConfiguration = {
  backlinks: {
    label: "Backlinks",
    operations: null,
    additionalOperations: new Set(["get_project_backlink_performance_v1"]),
  },
  platform: {
    label: "Platform",
    operations: new Set([
      "platformListWebsiteProjectsV1",
      "platformCreateWebsiteProjectV1",
      "platformGetWebsiteProjectV1",
      "platformUpdateWebsiteProjectV1",
      "platformArchiveWebsiteProjectV1",
      "platformRestoreWebsiteProjectV1",
    ]),
    additionalOperations: new Set(),
  },
}[requestedModule]
if (!moduleConfiguration) {
  throw new Error(`Unsupported generated client module: ${requestedModule}`)
}
const outputUrl = new URL(
  `../src/api/generated/${requestedModule}.ts`,
  import.meta.url
)
const methods = new Set(["get", "post", "put", "patch", "delete"])

const source = await readFile(sourceUrl, "utf8")
const document = JSON.parse(source)
const sourceHash = createHash("sha256").update(source).digest("hex")

function resolveRef(ref) {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported OpenAPI ref: ${ref}`)
  const value = ref
    .slice(2)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, token) => current?.[token], document)
  if (value === undefined) throw new Error(`Unresolved OpenAPI ref: ${ref}`)
  return value
}

function typeName(value) {
  const cleaned = value.replace(/[^A-Za-z0-9_$]/g, "_")
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `Schema_${cleaned}`
}

function closedObjectPropertyNames(schema) {
  const resolved = schema?.$ref ? resolveRef(schema.$ref) : schema
  if (
    !resolved ||
    resolved.additionalProperties !== false ||
    (resolved.type !== "object" && !resolved.properties)
  ) {
    return null
  }
  return new Set(Object.keys(resolved.properties ?? {}))
}

function schemaType(schema, seen = new Set()) {
  if (!schema) return "unknown"
  const withNullable = (value) =>
    schema.nullable && value !== "null" ? `${value} | null` : value
  if (schema.$ref) {
    const name = typeName(schema.$ref.split("/").at(-1))
    resolveRef(schema.$ref)
    return withNullable(name)
  }
  if (schema.const !== undefined) {
    return withNullable(JSON.stringify(schema.const))
  }
  if (schema.enum) {
    return withNullable(schema.enum.map(JSON.stringify).join(" | ") || "never")
  }
  if (schema.oneOf || schema.anyOf) {
    const options = schema.oneOf ?? schema.anyOf
    const optionPropertyNames = options.map(closedObjectPropertyNames)
    if (optionPropertyNames.every((names) => names !== null)) {
      const allPropertyNames = new Set(
        optionPropertyNames.flatMap((names) => [...names])
      )
      return withNullable(
        options
          .map((item, index) => {
            const ownPropertyNames = optionPropertyNames[index]
            const excludedProperties = [...allPropertyNames].filter(
              (name) => !ownPropertyNames.has(name)
            )
            const baseType = schemaType(item, seen)
            if (excludedProperties.length === 0) return baseType
            return `(${baseType} & {\n${excludedProperties
              .map((name) => `    ${JSON.stringify(name)}?: never`)
              .join("\n")}\n  })`
          })
          .join(" | ")
      )
    }
    return withNullable(
      options.map((item) => schemaType(item, seen)).join(" | ")
    )
  }
  if (schema.allOf) {
    return withNullable(
      schema.allOf.map((item) => schemaType(item, seen)).join(" & ")
    )
  }

  let result
  if (schema.type === "array" || schema.items) {
    result = `Array<${schemaType(schema.items, seen)}>`
  } else if (
    schema.type === "object" ||
    schema.properties ||
    schema.additionalProperties
  ) {
    if (seen.has(schema)) return "unknown"
    const nextSeen = new Set(seen).add(schema)
    const required = new Set(schema.required ?? [])
    const properties = Object.entries(schema.properties ?? {}).map(
      ([name, value]) =>
        `    ${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(value, nextSeen)}`
    )
    const objectType =
      properties.length === 0 ? "{}" : `{\n${properties.join("\n")}\n  }`
    if (schema.additionalProperties === true) {
      result = `${objectType} & Record<string, unknown>`
    } else if (typeof schema.additionalProperties === "object") {
      const valueType = schemaType(schema.additionalProperties, nextSeen)
      result =
        properties.length === 0
          ? `{ [key: string]: ${valueType} }`
          : `${objectType} & { [key: string]: ${valueType} }`
    } else {
      result = objectType
    }
  } else if (schema.type === "string") {
    result = "string"
  } else if (schema.type === "number" || schema.type === "integer") {
    result = "number"
  } else if (schema.type === "boolean") {
    result = "boolean"
  } else if (schema.type === "null") {
    result = "null"
  } else {
    result = "unknown"
  }
  return withNullable(result)
}

function parametersFor(pathItem, operation, location) {
  const parameters = [
    ...(pathItem.parameters ?? []),
    ...(operation.parameters ?? []),
  ]
    .map((parameter) =>
      parameter.$ref ? resolveRef(parameter.$ref) : parameter
    )
    .filter((parameter) => parameter.in === location)
  const required = parameters.filter((parameter) => parameter.required)
  return schemaType({
    type: "object",
    properties: Object.fromEntries(
      parameters.map((parameter) => [parameter.name, parameter.schema])
    ),
    required: required.map((parameter) => parameter.name),
    additionalProperties: false,
  })
}

function jsonSchema(content) {
  return content?.["application/json"]?.schema
}

function requestBodyType(operation) {
  if (!operation.requestBody) return "never"
  const requestBody = operation.requestBody.$ref
    ? resolveRef(operation.requestBody.$ref)
    : operation.requestBody
  return schemaType(jsonSchema(requestBody.content))
}

function responseType(operation) {
  const responseEntry = Object.entries(operation.responses ?? {})
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => Number(left) - Number(right))[0]
  if (!responseEntry) {
    throw new Error(
      `Operation ${operation.operationId} has no success response`
    )
  }
  const response = responseEntry[1].$ref
    ? resolveRef(responseEntry[1].$ref)
    : responseEntry[1]
  return schemaType(jsonSchema(response.content))
}

const operations = Object.entries(document.paths ?? {}).flatMap(
  ([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(
        ([method, operation]) =>
          methods.has(method) &&
          ((operation["x-growthos-module"] === requestedModule &&
            (moduleConfiguration.operations === null ||
              moduleConfiguration.operations.has(operation.operationId))) ||
            moduleConfiguration.additionalOperations.has(operation.operationId))
      )
      .map(([method, operation]) => ({ method, path, pathItem, operation }))
)

if (operations.length === 0) {
  throw new Error(`No ${moduleConfiguration.label} operations found`)
}
const operationIds = operations.map(({ operation }) => operation.operationId)
if (new Set(operationIds).size !== operationIds.length) {
  throw new Error(`Duplicate ${moduleConfiguration.label} operationId`)
}

const referencedSchemas = new Map()
function collectRefs(value) {
  if (!value || typeof value !== "object") return
  if (typeof value.$ref === "string") {
    const name = typeName(value.$ref.split("/").at(-1))
    const schema = resolveRef(value.$ref)
    if (!referencedSchemas.has(name)) {
      referencedSchemas.set(name, schema)
      collectRefs(schema)
    }
  }
  for (const child of Object.values(value)) collectRefs(child)
}
for (const { operation } of operations) collectRefs(operation)

const componentTypes = [...referencedSchemas.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, schema]) => `export type ${name} = ${schemaType(schema)}`)
  .join("\n\n")

const operationTypes = operations
  .map(({ method, path, pathItem, operation }) => {
    return `  ${JSON.stringify(operation.operationId)}: {
    method: ${JSON.stringify(method.toUpperCase())}
    path: ${JSON.stringify(path)}
    pathParameters: ${parametersFor(pathItem, operation, "path")}
    query: ${parametersFor(pathItem, operation, "query")}
    headers: ${parametersFor(pathItem, operation, "header")}
    body: ${requestBodyType(operation)}
    response: ${responseType(operation)}
  }`
  })
  .join("\n")

const operationRuntime = operations
  .map(
    ({ method, path, operation }) =>
      `  ${JSON.stringify(operation.operationId)}: { method: ${JSON.stringify(method.toUpperCase())}, path: ${JSON.stringify(path)} },`
  )
  .join("\n")

const rawOutput = `/* eslint-disable */
// Generated by scripts/generate-backlinks-client.mjs. Do not edit.
// Source: backend/contracts/openapi/platform.v1.json
// Source SHA-256: ${sourceHash}

import { apiRequest } from "@/api/client"

${componentTypes}

export interface ${moduleConfiguration.label}Operations {
${operationTypes}
}

export type ${moduleConfiguration.label}OperationId = keyof ${moduleConfiguration.label}Operations
type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K
}[keyof T]
type RequestPart<Name extends string, T> = keyof T extends never
  ? {}
  : RequiredKeys<T> extends never
    ? { [K in Name]?: T }
    : { [K in Name]: T }
type BodyPart<T> = [T] extends [never] ? {} : { body: T }

export type ${moduleConfiguration.label}Request<K extends ${moduleConfiguration.label}OperationId> =
  & RequestPart<"path", ${moduleConfiguration.label}Operations[K]["pathParameters"]>
  & RequestPart<"query", ${moduleConfiguration.label}Operations[K]["query"]>
  & RequestPart<"headers", ${moduleConfiguration.label}Operations[K]["headers"]>
  & BodyPart<${moduleConfiguration.label}Operations[K]["body"]>

export type ${moduleConfiguration.label}Response<K extends ${moduleConfiguration.label}OperationId> =
  ${moduleConfiguration.label}Operations[K]["response"]

const operations = {
${operationRuntime}
} as const

function appendQueryValue(query: URLSearchParams, name: string, value: unknown) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    value.forEach((item) => query.append(name, String(item)))
    return
  }
  query.set(name, String(value))
}

export function request${moduleConfiguration.label}<K extends ${moduleConfiguration.label}OperationId>(
  operationId: K,
  input: ${moduleConfiguration.label}Request<K>,
  options: { signal?: AbortSignal; headers?: HeadersInit } = {}
): Promise<${moduleConfiguration.label}Response<K>> {
  const operation = operations[operationId]
  const request = input as {
    path?: Record<string, unknown>
    query?: Record<string, unknown>
    headers?: Record<string, unknown>
    body?: unknown
  }
  let path = operation.path.replace(/{([^}]+)}/g, (_, name: string) => {
    const value = request.path?.[name]
    if (value === undefined) throw new Error(\`Missing path parameter: \${name}\`)
    return encodeURIComponent(String(value))
  })
  const query = new URLSearchParams()
  Object.entries(request.query ?? {}).forEach(([name, value]) =>
    appendQueryValue(query, name, value)
  )
  if (query.size > 0) path += \`?\${query.toString()}\`

  const headers = new Headers(options.headers)
  Object.entries(request.headers ?? {}).forEach(([name, value]) => {
    if (value !== undefined) headers.set(name, String(value))
  })
  const hasBody = Object.prototype.hasOwnProperty.call(request, "body")
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return apiRequest<${moduleConfiguration.label}Response<K>>(path, {
    method: operation.method,
    headers,
    body: hasBody ? JSON.stringify(request.body) : undefined,
    signal: options.signal,
  })
}
`
const outputPath = fileURLToPath(outputUrl)
const prettierConfig = (await prettier.resolveConfig(outputPath)) ?? {}
const output = await prettier.format(rawOutput, {
  ...prettierConfig,
  filepath: outputPath,
})

if (process.argv.includes("--check")) {
  const current = await readFile(outputUrl, "utf8").catch(() => "")
  if (current !== output) {
    throw new Error(
      "Generated Backlinks client is stale; run npm run generate:backlinks-client"
        .replaceAll("Backlinks", moduleConfiguration.label)
        .replaceAll("backlinks", requestedModule)
    )
  }
  console.log(
    `Generated ${moduleConfiguration.label} client valid: ${operations.length} operations`
  )
} else {
  await writeFile(outputUrl, output, "utf8")
  console.log(
    `Generated ${moduleConfiguration.label} client written: ${operations.length} operations`
  )
}
