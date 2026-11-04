/**
 * Stress tasks for a real OpenCode session through the proxy. Each task seeds a
 * fresh directory, gives the agent one prompt (in several languages on purpose:
 * nothing in the proxy may depend on the language), and verifies the result
 * with plain commands - the agent's own claims are never trusted.
 *
 * `verify(dir, sh)` returns an error message, or null when the task is done.
 */

const CALC = `def add(a, b):
    return a - b


def mul(a, b):
    return a + b


def div(a, b):
    return a // b
`

const TEST_CALC = `from calc import add, mul, div

assert add(2, 3) == 5
assert mul(4, 5) == 20
assert div(7, 2) == 3.5
print("ok")
`

const CSV = `name,category,amount
"Widget, large",tools,12.50
Hammer,tools,30
Apple,food,1.25
"Bread, rye",food,3.75
Lamp,home,40
`

const LOG = [
  '10.0.0.1 - - [01/Nov/2026:10:00:01] "GET / HTTP/1.1" 200 512',
  '10.0.0.2 - - [01/Nov/2026:10:00:02] "GET /a HTTP/1.1" 404 10',
  '10.0.0.1 - - [01/Nov/2026:10:00:03] "GET /b HTTP/1.1" 500 10',
  '10.0.0.3 - - [01/Nov/2026:10:00:04] "POST /c HTTP/1.1" 403 10',
  '10.0.0.1 - - [01/Nov/2026:10:00:05] "GET /d HTTP/1.1" 200 10',
  '10.0.0.2 - - [01/Nov/2026:10:00:06] "GET /e HTTP/1.1" 502 10',
  '10.0.0.4 - - [01/Nov/2026:10:00:07] "GET /f HTTP/1.1" 200 10',
  '10.0.0.1 - - [01/Nov/2026:10:00:08] "GET /g HTTP/1.1" 404 10',
].join('\n')

const LEGACY = `def report(rows):
    out = []
    total = 0
    for r in rows:
        total += r
    out.append("sum=" + str(total))
    total = 0
    for r in rows:
        total += r * r
    out.append("squares=" + str(total))
    total = 0
    for r in rows:
        total += r * r * r
    out.append("cubes=" + str(total))
    return out
`

const HARNESS = `from legacy import report
for line in report([1, 2, 3, 4]):
    print(line)
`

const GREET = {
  'lib/greet.py': 'def greet_user(name):\n    return "Hello, " + name\n',
  'lib/__init__.py': '',
  'app.py': 'from lib.greet import greet_user\nprint(greet_user("Ada"))\n',
  'cli.py': 'import sys\nfrom lib.greet import greet_user\nprint(greet_user(sys.argv[1] if len(sys.argv) > 1 else "you"))\n',
  'test_greet.py': 'from lib.greet import greet_user\nassert greet_user("Bo") == "Hello, Bo"\nprint("ok")\n',
}

export const TASKS = [
  {
    id: 'fizzbuzz-tr',
    files: {},
    prompt:
      'fizz.py oluştur: fizz(n) fonksiyonu 1..n için liste döndürsün; 3\'ün katı "Fizz", 5\'in katı "Buzz", ikisi birden "FizzBuzz", diğerleri sayının string hali. Ayrıca selftest.py yaz (assert\'lerle) ve çalıştır. Onay bekleme.',
    verify(dir, sh) {
      const run = sh('python3 selftest.py', dir)
      if (run.status !== 0) return `selftest.py failed: ${run.out.slice(-200)}`
      const check = sh(`python3 -c "from fizz import fizz; print(fizz(15)[-1], fizz(15)[2], fizz(15)[4], fizz(15)[0])"`, dir)
      return check.out.trim() === 'FizzBuzz Fizz Buzz 1' ? null : `fizz(15) wrong: ${check.out.trim()}`
    },
  },
  {
    id: 'calc-fix-tr',
    files: { 'calc.py': CALC, 'test_calc.py': TEST_CALC },
    prompt: 'test_calc.py geçmiyor. calc.py içindeki hataları düzelt, test dosyasına DOKUNMA. Sonra testi çalıştır ve geçtiğini göster. Onay bekleme, bitirmeden durma.',
    verify(dir, sh, seeded) {
      if (sh('cat test_calc.py', dir).out !== seeded['test_calc.py']) return 'test_calc.py was modified'
      const run = sh('python3 test_calc.py', dir)
      return run.status === 0 && run.out.trim() === 'ok' ? null : `test fails: ${run.out.slice(-200)}`
    },
  },
  {
    id: 'csv-summary-en',
    files: { 'data.csv': CSV },
    prompt:
      'Read data.csv and write summary.py that prints the total amount per category as "category total" lines (total with two decimals), sorted by total, largest first. The name column can contain commas inside quotes. Run it and show the output. Do not ask for confirmation.',
    verify(dir, sh) {
      const run = sh('python3 summary.py', dir)
      const lines = run.out.trim().split('\n').map((line) => line.trim())
      const want = ['tools 42.50', 'home 40.00', 'food 5.00']
      return JSON.stringify(lines) === JSON.stringify(want) ? null : `unexpected output: ${JSON.stringify(lines)}`
    },
  },
  {
    id: 'log-analysis-de',
    files: { 'app.log': LOG },
    prompt:
      'app.log ist ein Webserver-Log. Schreibe analyze.sh, das die Anzahl der 4xx-Anfragen, die Anzahl der 5xx-Anfragen und die IP mit den meisten Anfragen ausgibt, genau in diesen drei Zeilen: "4xx: n", "5xx: n", "TOP IP: ip (n)". Führe es aus und zeige die Ausgabe. Frag nicht nach.',
    verify(dir, sh) {
      const run = sh('sh analyze.sh', dir)
      const out = run.out.trim().split('\n').map((line) => line.trim())
      const want = ['4xx: 3', '5xx: 2', 'TOP IP: 10.0.0.1 (4)']
      return want.every((line) => out.includes(line)) ? null : `unexpected output: ${JSON.stringify(out)}`
    },
  },
  {
    id: 'package-ja',
    files: { 'sample.txt': 'the cat and the dog and THE bird\nA cat, a dog.\n' },
    prompt:
      'wc_tool という Python パッケージを作ってください: wc_tool/__init__.py、wc_tool/util.py (単語を数える関数 count_words を置く)、wc_tool/__main__.py。`python3 -m wc_tool --file sample.txt --top 3` で、小文字化して句読点を除いた単語の出現回数上位3件を「単語 回数」の形式で多い順に出力すること。実行して出力を見せてください。確認は不要です。',
    verify(dir, sh) {
      const run = sh('python3 -m wc_tool --file sample.txt --top 3', dir)
      const lines = run.out.trim().split('\n').map((line) => line.trim())
      if (run.status !== 0) return `module failed: ${run.out.slice(-200)}`
      if (!sh('test -f wc_tool/util.py && grep -q "def count_words" wc_tool/util.py', dir).ok) return 'count_words missing in util.py'
      return lines[0] === 'the 3' && lines.length === 3 && lines.slice(1).every((line) => /^(and|cat|dog|a) 2$/.test(line))
        ? null
        : `unexpected output: ${JSON.stringify(lines)}`
    },
  },
  {
    id: 'refactor-es',
    files: { 'legacy.py': LEGACY, 'harness.py': HARNESS },
    prompt:
      'legacy.py tiene tres bloques repetidos. Extráelos a UNA sola función auxiliar sin cambiar el comportamiento: la salida de `python3 harness.py` no debe cambiar. Primero ejecútalo para ver la salida inicial, luego refactoriza y vuelve a ejecutarlo para comparar. No pidas confirmación.',
    verify(dir, sh) {
      const run = sh('python3 harness.py', dir)
      if (run.out.trim() !== 'sum=10\nsquares=30\ncubes=100') return `output changed: ${JSON.stringify(run.out)}`
      const loops = (sh('cat legacy.py', dir).out.match(/for r in rows/g) ?? []).length
      return loops <= 1 ? null : `still ${loops} loops: not refactored`
    },
  },
  {
    id: 'rename-multi-tr',
    files: GREET,
    prompt:
      'greet_user fonksiyonunun adını projede her yerde welcome olarak değiştir (tanım, tüm import\'lar ve çağrılar). Sonra test_greet.py ve app.py\'yi çalıştırıp geçtiğini göster. Hepsini bitirmeden durma, onay bekleme.',
    verify(dir, sh) {
      if (sh('grep -rn greet_user --include=*.py .', dir).out.trim()) return 'greet_user still referenced'
      const test = sh('python3 test_greet.py', dir)
      if (test.out.trim() !== 'ok') return `test_greet.py: ${test.out.slice(-200)}`
      const app = sh('python3 app.py', dir)
      return app.out.trim() === 'Hello, Ada' ? null : `app.py: ${app.out.slice(-200)}`
    },
  },
  {
    id: 'write-then-fix-en',
    files: {},
    prompt:
      'Create stats.py with a function median(values) that returns the median of a list of numbers (average of the two middle values for an even count) and raises ValueError on an empty list. Then create test_stats.py with at least 5 asserts covering odd, even, unsorted, negative and empty inputs, run it, and fix anything that fails until it passes. Do not stop before it passes.',
    verify(dir, sh) {
      const run = sh('python3 test_stats.py', dir)
      if (run.status !== 0) return `test_stats.py fails: ${run.out.slice(-200)}`
      const check = sh(
        `python3 -c "from stats import median as m\ntry:\n    m([])\n    print('no error')\nexcept ValueError:\n    print(m([3,1,2]), m([4,1,3,2]), m([-5,-1]))"`,
        dir,
      )
      return check.out.trim() === '2 2.5 -3.0' ? null : `median wrong: ${check.out.trim()}`
    },
  },
]
