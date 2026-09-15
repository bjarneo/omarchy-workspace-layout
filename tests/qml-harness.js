const fs = require("node:fs")
const path = require("node:path")

// Execute the actual QML functions with controlled properties and process replies.
function qmlFunction(file, name, scope) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
  const match = new RegExp("^([ \\t]*)function " + name + "\\(([^\\n]*)\\)(?:\\s*:\\s*\\w+)?\\s*\\{", "m").exec(source)
  if (!match) throw new Error("No QML function " + file + ":" + name)
  const start = match.index + match[0].length
  const end = source.indexOf("\n" + match[1] + "}", start)
  if (end < 0) throw new Error("No end for QML function " + file + ":" + name)
  const args = match[2].replace(/:\s*\w+/g, "")
  return new Function("scope", "with (scope) { return function(" + args + ") {" +
    source.slice(start, end) + "\n} }")(scope)
}

module.exports = { qmlFunction }
