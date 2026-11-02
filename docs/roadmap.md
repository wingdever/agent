# roadmap



## model-provide
### hardcode
### config
1. let core read baseurl + apikey from providers/models/confs tables.
instead of hardcode.

## agent-loop
### bare-chat
#### stream-output
### turn-step
### goal-plan
### propmt-assemble

## session-save

## tool
### filesystem
### database

## skill

## plugin-system



## context-compress

## shell


## subagents
## websearch
## settings

## net-track
## auto-translate
### MVP (done)
- 中文输入先翻译为英文再发给模型；英文回答翻译为中文显示；中英对照；设置开关。见 docs/translate.md。
- 翻译不落库（只存英文）。
### next
- 点词翻译 / 生词本 / 发音。
- 可选的翻译结果持久化（旧会话直接删除，不做迁移）。
