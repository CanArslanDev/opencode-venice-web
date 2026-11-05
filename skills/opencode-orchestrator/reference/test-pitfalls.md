# Test pitfalls: vitest + jsdom + React + state stores

Read this when worker-written tests fail in ways that look random.

- **Fake timers and promises**: after `render` and after every interaction, flush with `await act(async () => { await vi.advanceTimersByTimeAsync(ms) })`. Use the async variant inside `act`, and restore real timers in `afterEach`.
- **Always `await` an async render helper.** An un-awaited render keeps running after the test and breaks the next one. Symptom: passes alone, fails in the whole file.
- **Module instances**: with `vi.resetModules()` in `beforeEach`, import the component *and every store* dynamically afterwards, so the test and the component share the same instances.
- **Fakes that refresh on mount**: a fake data source whose `list()` returns `[]` wipes what the test seeded when the component reloads on mount. Let `list()` return a variable the test sets.
- **Event fakes with one listener** lose events when two consumers subscribe. Keep a `Set` of listeners and fan out.
- **Menus and popovers** (Radix and similar) do not open on a plain `.click()` in jsdom. Copy how an existing passing test opens them (pointer or keyboard events) and query `document.body` when they render in a portal.
- **One failing test can poison the following ones** through leaked timers or listeners: reproduce each failure alone first.
- **Mocked modules** must export every member the code under test calls; type the stub as `Partial<…>` of the real interface.
- **Side effects during render** (mutating a store in the render body) break under test and in strict mode; they belong in `useEffect`.
- Check where the test runner actually looks for tests (`include` in the config) before adding a test file somewhere new.
