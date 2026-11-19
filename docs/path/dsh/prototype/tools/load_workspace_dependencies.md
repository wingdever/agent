# `load_workspace_dependencies`

## name

`load_workspace_dependencies`

## description

模型收到的工具说明原文：

```text
Get absolute paths to bundled Python and library directories, plus bundled Python distribution versions. Node.js and pnpm paths are included when the payload provides them. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. When Node.js and pnpm paths are returned, run pnpm with that Node executable and pnpm script path. This does not change PATH or package-manager settings.
```

## system-section

`@deepseek-ai/dsh-tool-workspace-dependencies` 不注册系统提示词段落。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {}
}
```

## result-format

返回工作区依赖安装/加载结果。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 仅挂载该插件的组合中出现。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 工作区声明了依赖 | 工具返回可加载的依赖清单 |
| 未声明依赖 | 工具返回空清单或提示 |

## 来源

- 包：`@deepseek-ai/dsh-tool-workspace-dependencies`（`reference/deepseek-harness/packages/skill/tool-workspace-dependencies`）
