const $ = (sel) => document.querySelector(sel);

$("#openOptions").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
});

$("#testBtn").addEventListener("click", () => {
  const text = $("#testInput").value.trim();
  if (!text) return;
  $("#testResult").textContent = "변환 중…";
  chrome.runtime.sendMessage({ type: "BIZTONE_TEST_CONVERT", text }, (res) => {
    if (!res || !res.ok) {
      $("#testResult").textContent = res?.error || "오류가 발생했습니다.";
      return;
    }
    $("#testResult").textContent = res.result || "(결과 없음)";
  });
});

$("#copyResult").addEventListener("click", async () => {
  const text = $("#testResult").textContent.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $("#copyResult").textContent = "복사됨 ✔";
    setTimeout(() => ($("#copyResult").textContent = "복사"), 1000);
  } catch (e) {
    alert("복사 실패: " + e);
  }
});