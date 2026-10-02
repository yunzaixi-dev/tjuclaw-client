/** A greeting for the hour of the day (0–23), ending in an open question. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 9) return '早上好，今天从哪里开始？';
  if (hour >= 9 && hour < 12) return '上午好，想做点什么？';
  if (hour >= 12 && hour < 14) return '中午好，有什么可以帮你？';
  if (hour >= 14 && hour < 18) return '下午好，接下来做什么？';
  if (hour >= 18 && hour < 23) return '晚上好，今天过得怎么样？';
  return '夜深了，还有什么要处理的？';
}
