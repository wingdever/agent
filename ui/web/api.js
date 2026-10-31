// 浏览器/Electron 通用客户端：默认 HTTP(SSE)，若 preload 提供了 ipc 桥则优先用 ipc
(function () {
  var BASE = window.AGENT_API_BASE || "http://127.0.0.1:18765";

  function httpClient() {
    return {
      name: "http",
      listFunctions: function () {
        return fetch(BASE + "/api/functions").then(function (r) { return r.json(); });
      },
      call: function (fn, params, onEvent) {
        return fetch(BASE + "/api/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fn: fn, params: params || {}, callId: Math.random().toString(36).slice(2) }),
        }).then(function (res) {
          var ct = res.headers.get("content-type") || "";
          if (ct.indexOf("text/event-stream") !== -1) {
            var reader = res.body.getReader();
            var dec = new TextDecoder();
            var buf = "";
            function pump() {
              return reader.read().then(function (r) {
                if (r.done) return;
                buf += dec.decode(r.value, { stream: true });
                var i;
                while ((i = buf.indexOf("\n\n")) !== -1) {
                  var block = buf.slice(0, i);
                  buf = buf.slice(i + 2);
                  var line = block.split("\n").filter(function (l) { return l.indexOf("data:") === 0; })[0];
                  if (!line) continue;
                  var data = line.slice(5).trim();
                  if (data === "[DONE]") continue;
                  try { var evt = JSON.parse(data); if (onEvent) onEvent(evt); } catch (e) {}
                }
                return pump();
              });
            }
            return pump();
          }
          return res.json();
        });
      },
    };
  }

  // 纯 web / http 模式：用隐藏的 <input webkitdirectory> 充当文件夹选择器
  function webkitFolderSelect() {
    return new Promise(function (resolve) {
      var input = document.createElement("input");
      input.type = "file";
      input.webkitdirectory = true;
      input.style.display = "none";
      input.addEventListener("change", function () {
        var files = input.files || [];
        var name = "";
        if (files.length && files[0].webkitRelativePath) name = files[0].webkitRelativePath.split("/")[0];
        else if (files.length) name = files[0].name;
        resolve(name || null);
        if (input.parentNode) input.parentNode.removeChild(input);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // 若页面由 Electron ipc 模式加载，window.agentBridge 已存在
  var base = window.agentBridge || httpClient();
  window.AgentClient = Object.assign({}, base, {
    selectFolder: (window.agentBridge && window.agentBridge.selectFolder) || webkitFolderSelect,
  });
})();
 