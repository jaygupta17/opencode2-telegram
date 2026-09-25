import { toTelegramHTML, splitMessage } from "md-to-telegram"

/** Escape for Telegram HTML text nodes (only three chars matter). */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * LLM markdown -> Telegram HTML. The converter guarantees balanced markup
 * even from half-written markdown (unclosed emphasis stays literal), so it
 * is safe to call on every streaming tick. Never throws.
 */
export const mdToHtml = (md: string): string => {
  try {
    return toTelegramHTML(md).text
  } catch {
    return esc(md)
  }
}

/** Entity-safe chunking: >4000 chars splits on block boundaries (tags closed at seams). */
export const splitHtml = (html: string): string[] =>
  html.length <= 4000 ? [html] : splitMessage(html, { format: "html" })

/** Degraded fallback when Telegram rejects our markup (400 can't parse entities). */
export const stripTags = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
