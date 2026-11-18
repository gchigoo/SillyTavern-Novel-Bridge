import { Tiktoken } from 'js-tiktoken/lite';
import cl100k from 'js-tiktoken/ranks/cl100k_base';

// Hindsight's REST endpoint counts cl100k_base tokens, independently of ST's
// writing-model tokenizer. Leave headroom below its default 500-token limit.
export const RECALL_QUERY_TOKENS = 480;
const encoding = new Tiktoken(cl100k);
export const recallTokenCount = text => encoding.encode(String(text), [], []).length;

function fit(points, budget, tail = false) {
  let low = 0, high = points.length;
  const part = n => (tail ? points.slice(points.length - n) : points.slice(0, n)).join('');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (recallTokenCount(part(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return part(low);
}

export function compactRecallQuery(value) {
  // Bound tokenizer work too: very long unbroken runs can make pure-JS BPE
  // expensive. Search needs the request and scene edges, not the entire middle.
  let points = Array.from(String(value || '').trim());
  if (points.length > 800) points = [...points.slice(0, 400), '\n…\n', ...points.slice(-400)];
  const text = points.join('');
  if (recallTokenCount(text) <= RECALL_QUERY_TOKENS) return text;
  points = Array.from(text);
  const separator = '\n…\n';
  let head = fit(points, 280);
  let tail = fit(points, RECALL_QUERY_TOKENS - recallTokenCount(head + separator) - 8, true);
  // Token merges at concatenation boundaries are not additive. Check the final
  // string; trim Unicode code points rather than splitting encoded token bytes.
  while (recallTokenCount(head + separator + tail) > RECALL_QUERY_TOKENS) {
    if (tail) tail = Array.from(tail).slice(1).join('');
    else head = Array.from(head).slice(0, -1).join('');
  }
  return head + separator + tail;
}
