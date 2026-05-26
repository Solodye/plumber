import { describe, expect, it } from 'vitest'

import { parseClarificationBlock } from './parse-clarification-block'

describe('parseClarificationBlock', () => {
  it('returns null when no block is present', () => {
    expect(parseClarificationBlock('Just some conversational text.')).toBeNull()
  })

  it('returns null for an empty block', () => {
    expect(parseClarificationBlock('<!-- CLARIFICATION_DATA\n-->')).toBeNull()
  })

  it('ignores a Q line with no question text', () => {
    const text = `<!-- CLARIFICATION_DATA\nQ:\n- A\n- B\n-->`.trim()
    expect(parseClarificationBlock(text)).toBeNull()
  })

  it('returns null when a question has fewer than 2 options', () => {
    const text = `
Some response.
<!-- CLARIFICATION_DATA
Q: What trigger?
- Form submission
-->
    `.trim()
    expect(parseClarificationBlock(text)).toBeNull()
  })

  it('parses a single question with 2 options', () => {
    const text = `
Understanding of workflow: ...

<!-- CLARIFICATION_DATA
Q: What kind of notifications do you want to send?
- Email notifications
- Slack messages
-->
    `.trim()
    expect(parseClarificationBlock(text)).toEqual([
      {
        question: 'What kind of notifications do you want to send?',
        options: ['Email notifications', 'Slack messages'],
      },
    ])
  })

  it('parses a single question with 3 options', () => {
    const text = `
<!-- CLARIFICATION_DATA
Q: Where should data be stored?
- Tiles
- M365 Excel
- Both
-->
    `.trim()
    expect(parseClarificationBlock(text)).toEqual([
      {
        question: 'Where should data be stored?',
        options: ['Tiles', 'M365 Excel', 'Both'],
      },
    ])
  })

  it('parses multiple questions', () => {
    const text = `
<!-- CLARIFICATION_DATA
Q: What trigger?
- Form submission
- Scheduled
Q: Where to store?
- Tiles
- M365 Excel
-->
    `.trim()
    expect(parseClarificationBlock(text)).toEqual([
      { question: 'What trigger?', options: ['Form submission', 'Scheduled'] },
      { question: 'Where to store?', options: ['Tiles', 'M365 Excel'] },
    ])
  })

  it('ignores non-Q/option lines inside the block', () => {
    const text = `
<!-- CLARIFICATION_DATA
Q: What trigger?
- Form submission
- Scheduled
some stray text the model added
-->
    `.trim()
    expect(parseClarificationBlock(text)).toEqual([
      { question: 'What trigger?', options: ['Form submission', 'Scheduled'] },
    ])
  })

  it('handles surrounding whitespace in the block', () => {
    const text = `
<!--  CLARIFICATION_DATA

Q:  What trigger?
  -  Form submission
  -  Scheduled

-->
    `.trim()
    expect(parseClarificationBlock(text)).toEqual([
      { question: 'What trigger?', options: ['Form submission', 'Scheduled'] },
    ])
  })

  it('returns null when block is present but all questions have < 2 options', () => {
    const text = `
<!-- CLARIFICATION_DATA
Q: What trigger?
- Form submission
-->
    `.trim()
    expect(parseClarificationBlock(text)).toBeNull()
  })
})
