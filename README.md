# agent
this project is for develop one llm ai agent.




## 1. file hirealchy:
reference/
    BrainyFlow
    TinyAgents
    mini-swe-agent
    microAgents
    KodeAgent
    ThinHarness
    mono-agent
    smolagents


## 2. 设计方案
1. UI和业务逻辑分离，
采用类似服务端/客户端的架构，
业务逻辑的各个功能模块实现在服务端，
UI则是客户端，可以适配多种客户端。
内核层core 传输层transport 界面层ui
2. 工具调用tool_call
LLM调用各种工具实现数据检索和数据处理。
3. 交互结点
GetAimContext
GetUserQuestion
意图分析
AskUserQuestion  {questions}
4. 

## state
  agent/  (主项目, electron 44.9.3)
  ├── package.json        main=launcher.js, AGENT_UI 开关就绪
  ├── launcher.js         ← 协调器：拉 transport + 按 AGENT_UI 选 UI
  ├── core/               ← 共享 transport / 业务逻辑
  └── ui/
      ├── electron/       ← 独立子项目, electron 44.9.3, 可单独 npm start
      │   ├── package.json
      │   ├── main.js     (导出 start/createWindow)
      │   └── preload.js
      └── web/            ← 渲染页 (被 electron 客户端 loadFile)



