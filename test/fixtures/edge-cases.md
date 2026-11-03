# Edge cases: long code, wide tables, deep lists

Paragraph with a very long unbroken token to test wrapping: https://example.com/some/extremely/long/path/that/keeps/going/and/going/with/query?param=value&another=value&yet_another_parameter=some_long_value_here_1234567890

## A code block taller than one page

```typescript
// line 01
export interface Settings {
  capacity: number;
  refillPerSec: number;
  failOpen: boolean;
  exemptKeys: string[];
}
// line 08
export function take(bucket: Settings, tokens: number, updated: number, now: number): [boolean, number] {
  const refilled = Math.min(bucket.capacity, tokens + (now - updated) * bucket.refillPerSec);
  if (refilled < 1) {
    return [false, (1 - refilled) / bucket.refillPerSec];
  }
  return [true, 0];
}
// line 16
// line 17
// line 18
// line 19
// line 20
// line 21
// line 22
// line 23
// line 24
// line 25
// line 26
// line 27
// line 28
// line 29
// line 30
// line 31
// line 32
// line 33
// line 34
// line 35
// line 36
// line 37
// line 38
// line 39
// line 40
// line 41
// line 42
// line 43
// line 44
// line 45
// line 46
// line 47
// line 48
// line 49
// line 50
// line 51
// line 52
// line 53
// line 54
// line 55
// line 56
// line 57
// line 58
// line 59
// line 60
// line 61
// line 62
// line 63
// line 64
// line 65
// line 66
// line 67
// line 68
// line 69
// line 70
// a very long single line of code that should wrap rather than overflow the page: const x = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree, argumentNumberFour, argumentNumberFive);
```

## A wide table

| Column A | Column B | Column C | Column D | Column E | Column F |
|---|---|---|---|---|---|
| `app/middleware/rate_limit.py` | new module | TokenBucket, RateLimitMiddleware | high | 2h | @hector |
| `app/config.py` | edit | RateLimitSettings | low | 30m | @hector |
| `app/main.py` | edit | register middleware | low | 15m | @hector |
| `tests/middleware/test_rate_limit.py` | new | fake clock + fake Redis | medium | 2h | @warren |
| `docs/api/limits.md` | new | headers and defaults, with a much longer description cell to see how wrapping behaves inside a table | low | 45m | @hector |

## Deeply nested lists and tasks

- Level one
  - Level two with `inline code` and **bold** and *italics* and ~~strikethrough~~
    - Level three
      - Level four
        1. Numbered inside bullets
        2. Second numbered
- [ ] An unchecked task at the top level
  - [x] A checked sub-task
  - [ ] An unchecked sub-task with a long line of text that will need to wrap onto a second line to make sure the checkbox alignment holds up
- Back to a plain bullet

## Headings right before a page break

### Heading 3

Text under heading 3.

#### Heading 4

Text under heading 4.

> A blockquote with
> multiple lines
>
> and a second paragraph.

---

Final paragraph after a horizontal rule. Inline HTML like <b>bold</b> and <script>alert(1)</script> should be sanitized.
