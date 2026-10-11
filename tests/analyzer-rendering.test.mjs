import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("analyzer findings render optional API diagnostic fields while escaping service content", () => {
  const source = readFileSync(new URL("../frontend/script/syntax-analyzer.js", import.meta.url), "utf8");
  const start = source.indexOf("    function updateErrorPanel()");
  const end = source.indexOf("    const data = readPendingAnalysis()", start);
  assert.ok(start >= 0 && end > start);
  const nodes = { errorList: {}, errorCount: {}, warningCount: {} };
  const context = {
    document: { getElementById(id) { return nodes[id]; } },
    currentErrors: [{
      line: "<img src=x onerror=alert(1)>",
      message: "<b>Syntax</b>", rule_id: "<svg/onload=alert(1)>",
      explanation: "<script>explanation</script>", source_line: "value = a & b", code_to_add: 'Use "quotes"'
    }],
    currentWarnings: [{ line: 5, message: "Warning", explanation: "Missing check", code_to_add: null }]
  };
  vm.runInNewContext(`${source.slice(start, end)}\nupdateErrorPanel();`, context);
  const html = nodes.errorList.innerHTML;
  assert.equal(nodes.errorCount.textContent, 1);
  assert.equal(nodes.warningCount.textContent, 1);
  assert.match(html, /finding-card warning/);
  assert.match(html, /&lt;script&gt;explanation&lt;\/script&gt;/);
  assert.match(html, /Related code:.*value = a &amp; b/s);
  assert.match(html, /Code to add.*Use &quot;quotes&quot;/s);
  assert.doesNotMatch(html, /Cause:|Impact:|Recommended action:/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
});
