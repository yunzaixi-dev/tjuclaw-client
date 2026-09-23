---
title: Markdown 全功能压力测试
aliases:
  - Markdown Lab
  - 编辑器验收文档
tags:
  - test/markdown
  - obsidian
  - anki
status: draft
created: 2026-09-22
---

# Markdown 全功能压力测试

> 这是一篇用于验收 TJUClaw 知识工作区的长文档。它不是产品内容，而是一张“语法地形图”：标题、链接、公式、表格、任务、代码、引用、标签和 Anki 卡片都会在这里留下痕迹。

## 0. 使用说明

- 在 **编辑** 模式查看原始 Markdown。
- 在 **阅读** 模式查看渲染结果。
- 使用右侧文档目录跳转到各级标题。
- 观察长代码块、长表格和嵌套列表的滚动行为。
- 修改任意一行，确认自动保存提示和再次打开后的内容。

**验收链接：**

- [TJUClaw 项目](https://github.com/yunzaixi-dev/tjuclaw)
- [内部工作区](app://workspace)
- [[Markdown 全功能压力测试]]
- [[不存在的双链]]

## 1. 标题层级与段落

### 1.1 三级标题

普通段落支持**粗体**、*斜体*、~~删除线~~、`行内代码`、<mark>高亮语义</mark>，也可以组合成 **加粗中的 `代码`**。

#### 1.1.1 四级标题

四级及更深标题仍然应当保持层级，不应该被错误地拼接到前一个段落中。

##### 1.1.1.1 五级标题

标题中包含中文、English、`inline code`、数学符号 $\alpha + \beta$ 和链接 [section](#标题层级与段落)。

###### 1.1.1.1.1 六级标题

这是最深一层标题。右侧目录可以只显示到三级，但正文不能丢失层级。

## 2. 列表、任务与定义

### 2.1 无序列表

- 第一层项目
  - 第二层项目
    - 第三层项目
      - 第四层项目
- 包含 **强调** 与 `代码`
- 包含链接：[MDN](https://developer.mozilla.org/)

### 2.2 有序列表

1. 建立知识库
2. 创建文件夹
3. 创建 Markdown 文档
   1. 写入正文
   2. 预览渲染
4. 移动到目标目录

### 2.3 任务列表

- [x] 实现编辑器
- [x] 实现阅读预览
- [x] 实现目录索引
- [x] 实现自定义下拉框
- [x] 实现自定义滚动条
- [ ] 接入服务端文件夹模型
- [ ] 导出真正的 `.apkg` Anki 包

### 2.4 定义列表

TJUClaw
: 天津大学校园行动智能体平台。

Vault
: 由文件夹、文档、会话和本地索引共同组成的知识空间。

## 3. 引用、提示与折叠

> 一级引用
>
> > 二级引用
> >
> > 引用可以包含 `代码`、**强调** 和 [链接](https://example.com)。

> [!NOTE] 设计说明
> 正文编辑与阅读预览必须共享同一份 Markdown 数据源，不能为预览单独维护另一套内容。

> [!TIP] 使用建议
> 先记录，再整理。把重要的定义、公式和反例放在同一篇文档里，方便回链。

<details>
<summary>点击展开：隐藏的验收内容</summary>

这里是可折叠内容。它包含一段很长的文本，用来确认详情元素不会撑破编辑器宽度，也不会影响滚动条计算。

</details>

## 4. 数学公式

### 4.1 行内公式

爱因斯坦质能关系是 $E = mc^2$。二次方程的根为 $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$。

### 4.2 块级公式

$$
\int_{-\infty}^{+\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

$$
\nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0},
\qquad
\nabla \times \mathbf{B} - \frac{1}{c^2}\frac{\partial \mathbf{E}}{\partial t}
= \mu_0\mathbf{J}
$$

$$
\begin{aligned}
f(x) &= x^2 + 2x + 1 \\
     &= (x + 1)^2 \\
\frac{df}{dx} &= 2x + 2
\end{aligned}
$$

> 公式验收要求：公式原文不能被吞掉；即使当前未加载 KaTeX，也应以清晰的代码或文本形式保留。

## 5. 表格

| 功能 | 输入语法 | 预期结果 | 状态 |
| --- | --- | --- | --- |
| 标题 | `# Heading` | 层级标题 | ✅ |
| 链接 | `[text](url)` | 可点击链接 | ✅ |
| 任务 | `- [ ] todo` | 复选框 | ✅ |
| 表格 | `\| a \| b \|` | 网格表格 | ✅ |
| 公式 | `$x^2$` | 数学表达式 | 兼容文本 |
| 双链 | `[[Note]]` | 知识库链接 | 需索引 |

### 对齐表格

| 左对齐 | 居中 | 右对齐 |
| :--- | :---: | ---: |
| 文字 | 12 | ¥99.00 |
| 长文本可以换行 | `code` | **重点** |

## 6. 代码与日志

### 6.1 TypeScript

```ts
type Backlink = {
  sourceId: string;
  targetTitle: string;
  createdAt: string;
};

export function collectBacklinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)].map(match => match[1]);
}
```

### 6.2 Go

```go
func normalizeTitle(title string) string {
    title = strings.TrimSpace(title)
    title = strings.Join(strings.Fields(title), " ")
    return title
}
```

### 6.3 Shell

```bash
rtk pnpm types:check
rtk pnpm lint
rtk pnpm build
```

### 6.4 JSON

```json
{
  "kind": "note",
  "title": "Markdown 全功能压力测试",
  "tags": ["markdown", "obsidian"],
  "features": ["headings", "tables", "links", "math", "anki"]
}
```

### 6.5 超长行

`0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`

## 7. 链接、图片与资源

自动链接：https://www.example.com

邮箱链接：<hello@example.com>

相对资源：

![TJUClaw logo](../components/brand-icon.webp "品牌图标")

脚注引用[^design]，第二个脚注引用[^md]。

[^design]: 视觉系统使用语义色，不把品牌色硬编码到页面组件中。
[^md]: Markdown 文档属于用户数据，预览时必须经过清洗。

## 8. 标签、双链与知识图谱

常用标签：#markdown #frontend #knowledge-base #test/editor

相关笔记：

- [[编辑器架构]]
- [[知识库目录设计]]
- [[Anki 导出协议]]
- [[会话上下文]]

反向链接测试目标：其他文档引用本页时，右侧应显示“被哪些文档链接”。

## 9. Anki 卡片语法

下面的内容可以作为手工制卡素材：

**Q:** 什么是 Markdown 的 fenced code block？

**A:** 使用三个反引号包裹代码，并可以在开头指定语言，以获得语法高亮和可读的代码块。

---

**Q:** TJUClaw 的笔记和会话为什么要放在同一个工作区？

**A:** 因为会话是知识生产过程，笔记是沉淀结果。两者共享目录、搜索和回链，才能形成完整的知识循环。

---

**Q:** 为什么预览必须使用 DOMPurify？

**A:** Markdown 允许 HTML，而用户内容不应直接作为未经清洗的 HTML 注入页面。

## 10. 分隔线与混合场景

---

这是分隔线后的段落。它故意紧接着一个表格、列表和代码块，测试块级元素之间的边界。

| 项目 | 数值 |
| --- | ---: |
| 文档字数 | 1800+ |
| 标题数量 | 30+ |
| 测试模块 | 12 |

- 这是列表
  ```js
  const nested = true;
  ```
- 列表结束

## 11. 验收清单

- [ ] 正文编辑不会丢失 YAML frontmatter
- [ ] 阅读模式支持 GFM 表格
- [ ] 阅读模式支持任务复选框
- [ ] 链接不会跳出当前应用布局
- [ ] 代码块可以横向滚动
- [ ] 表格不会撑破文章容器
- [ ] 目录可以识别一到六级标题
- [ ] 公式原文在未加载数学引擎时仍可读
- [ ] 双链可以进入链接解析流程
- [ ] 标签可以被索引
- [ ] 文档移动后内容和目录关系不变
- [ ] 刷新页面后文件夹与文档归档仍然存在

## 12. 结论

如果你能在这篇文档中顺利完成编辑、预览、搜索、目录跳转、移动、归档和 Anki 素材提取，说明编辑器已经覆盖了一个可用知识库的主要交互面。

最后再留一个链接：回到[开头](#markdown-全功能压力测试)。
