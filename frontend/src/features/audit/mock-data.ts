export const auditRows = [
  {
    item: "缺少或重复的页面标题",
    type: "错误",
    count: 18,
    change: "-4",
    owner: "未分配",
  },
  {
    item: "内部链接指向 4xx 页面",
    type: "错误",
    count: 11,
    change: "+2",
    owner: "技术组",
  },
  {
    item: "图片缺少 alt 文本",
    type: "警告",
    count: 47,
    change: "-9",
    owner: "内容组",
  },
  {
    item: "可索引页面加载时间超过 3 秒",
    type: "警告",
    count: 26,
    change: "-3",
    owner: "技术组",
  },
  {
    item: "页面仅有一个内部入链",
    type: "提示",
    count: 63,
    change: "+5",
    owner: "未分配",
  },
] as const
