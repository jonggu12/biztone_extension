function load() {
  chrome.storage.sync.get(["OPENAI_API_KEY", "OPENAI_MODEL"], (res) => {
    if (res.OPENAI_API_KEY) document.getElementById("apiKey").value = res.OPENAI_API_KEY;
    if (res.OPENAI_MODEL) document.getElementById("model").value = res.OPENAI_MODEL;
  });
}

function save() {
  let apiKey = document.getElementById("apiKey").value.trim();
  apiKey = apiKey.replace(/^(["']+)|(["']+)$/g, "").trim();
  const model = document.getElementById("model").value;
  chrome.storage.sync.set({ OPENAI_API_KEY: apiKey, OPENAI_MODEL: model }, () => {
    alert("저장되었습니다.");
  });
}

document.getElementById("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);

function setStatus(msg, ok=true) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = ok ? "#10b981" : "#ef4444";
}

async function validate() {
  let apiKey = document.getElementById("apiKey").value.trim();
  apiKey = apiKey.replace(/^(["']+)|(["']+)$/g, "").trim();

  if (!apiKey || !apiKey.startsWith("sk-")) {
    setStatus("유효하지 않은 키 형식입니다. sk- 로 시작해야 합니다.", false);
    return;
  }
  setStatus("검증 중…", true);
  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (res.status === 200) {
      setStatus("검증 완료: 키가 유효합니다.", true);
    } else if (res.status === 401) {
      const t = await res.text();
      setStatus("401 Unauthorized: 키가 잘못되었거나 권한이 없습니다. " + t, false);
    } else {
      setStatus(`검증 실패: HTTP ${res.status}`, false);
    }
  } catch (e) {
    setStatus("네트워크 오류: " + (e?.message || e), false);
  }
}

document.getElementById("validate").addEventListener("click", validate);
