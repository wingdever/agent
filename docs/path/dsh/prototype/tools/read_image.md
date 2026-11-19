# `read_image`

## name

`read_image`

## description

模型收到的工具说明原文：

```text
Read a PNG/JPEG/WebP/GIF file and return the image itself. Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image.
```

## system-section

不单独贡献段落；图像工具的模型可见说明来自工具描述与 `read` 段落的读前约束。

## schema

参数 JSON Schema（取自参考快照工具目录）：

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to the image file, resolved by the filesystem backend."
    }
  },
  "required": [
    "file_path"
  ]
}
```

## result-format

返回 durable 图片附件引用，模型收到一张带描述的图片块（附件 id、媒体类型、尺寸与只读路径），后续请求按路由能力以 Files 引用或内联 base64 重发。

失败统一为 `Error: <message>`：工具抛出的错误、参数校验失败（`Error: invalid arguments: …`）、未知工具（`Error: unknown tool "<name>"`）都走同一条错误文本通道。

## 启用条件与可见性

- 组合装配了附件服务（`ctx.attachments`）时注册。
- schema 与路由无关；执行时要求当前路由声明了图片输入能力，否则拒绝。
- 接受 PNG / JPEG / WebP / GIF，按魔数校验。

## 组合条件

本工具与其它工具、执行能力组合时，模型可见契约会发生的变化。每行是「当……时 → 变化」。

| 当 | 变化 |
|---|---|
| 未装配 `ctx.attachments` | `read_image` 不注册，模型看不到这个工具 |
| `read` 可见 | 无变化；两者独立 |
| 执行器换成 PTC | 改从 `tools:sdk` 调用；附件能力要求与 native 相同 |

## 来源

- 包：`@deepseek-ai/dsh-tool-fs`（`reference/deepseek-harness/packages/fs/tool-fs`）
