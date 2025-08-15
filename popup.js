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

// ==================== DOMAIN MANAGEMENT ====================

let currentDomain = null;
let domainStatus = null;

/**
 * Get current active tab domain
 */
async function getCurrentTabDomain() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      const url = new URL(tabs[0].url);
      return url.hostname.toLowerCase();
    }
  } catch (error) {
    console.error('Failed to get current tab domain:', error);
  }
  return null;
}

/**
 * Load domain status from background
 */
async function loadDomainStatus() {
  currentDomain = await getCurrentTabDomain();
  
  if (!currentDomain) {
    $("#currentDomain").textContent = "도메인을 감지할 수 없음";
    $("#domainStatus").textContent = "";
    $("#toggleDomain").style.display = "none";
    $("#pauseOptions").style.display = "none";
    return;
  }

  $("#currentDomain").textContent = currentDomain;
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_DOMAIN_STATUS',
      domain: currentDomain
    });
    
    if (response?.ok && response.result) {
      domainStatus = response.result;
      updateDomainUI();
    } else {
      $("#domainStatus").textContent = "상태 로딩 실패";
    }
  } catch (error) {
    console.error('Failed to load domain status:', error);
    $("#domainStatus").textContent = "연결 오류";
  }
}

/**
 * Update domain UI based on current status
 */
function updateDomainUI() {
  if (!domainStatus) return;
  
  const { enabled, paused, pauseRemaining } = domainStatus;
  
  // Update status text
  if (paused) {
    $("#domainStatus").textContent = `⏸️ ${pauseRemaining}분 일시중지`;
    $("#domainStatus").style.color = "#fbbf24";
  } else if (enabled) {
    $("#domainStatus").textContent = "✅ 활성";
    $("#domainStatus").style.color = "#10b981";
  } else {
    $("#domainStatus").textContent = "🔇 비활성";
    $("#domainStatus").style.color = "#ef4444";
  }
  
  // Update toggle button
  if (paused) {
    $("#toggleText").textContent = "일시중지 해제";
    $("#toggleDomain").style.background = "#fbbf24";
    $("#toggleDomain").style.color = "#000";
  } else if (enabled) {
    $("#toggleText").textContent = "사이트에서 끄기";
    $("#toggleDomain").style.background = "#ef4444";
    $("#toggleDomain").style.color = "#fff";
  } else {
    $("#toggleText").textContent = "사이트에서 켜기";
    $("#toggleDomain").style.background = "#10b981";
    $("#toggleDomain").style.color = "#fff";
  }
}

/**
 * Toggle domain enabled/disabled
 */
async function toggleDomain() {
  if (!currentDomain) return;
  
  const originalText = $("#toggleText").textContent;
  $("#toggleText").textContent = "처리 중...";
  
  try {
    // If paused, resume; otherwise toggle enabled status
    const messageType = domainStatus.paused ? 'BIZTONE_SET_DOMAIN_RULE' : 'BIZTONE_TOGGLE_DOMAIN';
    const message = domainStatus.paused 
      ? { type: messageType, domain: currentDomain, options: { pauseUntil: 0 } }
      : { type: messageType, domain: currentDomain };
    
    const response = await chrome.runtime.sendMessage(message);
    
    if (response?.ok && response.result) {
      domainStatus = response.result;
      updateDomainUI();
      
      // Show feedback
      const action = domainStatus.enabled ? "활성화" : "비활성화";
      $("#domainStatus").textContent = `${action} 완료!`;
      setTimeout(() => updateDomainUI(), 1000);
    } else {
      $("#toggleText").textContent = "오류 발생";
      setTimeout(() => $("#toggleText").textContent = originalText, 1000);
    }
  } catch (error) {
    console.error('Failed to toggle domain:', error);
    $("#toggleText").textContent = "연결 오류";
    setTimeout(() => $("#toggleText").textContent = originalText, 1000);
  }
}

/**
 * Pause domain for specified minutes
 */
async function pauseDomain(minutes) {
  if (!currentDomain) return;
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_PAUSE_DOMAIN',
      domain: currentDomain,
      minutes: minutes
    });
    
    if (response?.ok && response.result) {
      domainStatus = response.result;
      updateDomainUI();
      $("#pauseMenu").style.display = "none";
      
      // Show feedback
      $("#domainStatus").textContent = `${minutes}분 일시중지됨!`;
      setTimeout(() => updateDomainUI(), 1500);
    } else {
      alert("일시중지 설정에 실패했습니다.");
    }
  } catch (error) {
    console.error('Failed to pause domain:', error);
    alert("연결 오류가 발생했습니다.");
  }
}

// ==================== EVENT LISTENERS ====================

// Domain toggle button
$("#toggleDomain").addEventListener("click", toggleDomain);

// Pause options button
$("#pauseOptions").addEventListener("click", () => {
  const menu = $("#pauseMenu");
  menu.style.display = menu.style.display === "none" ? "block" : "none";
});

// Pause time buttons
document.querySelectorAll(".pause-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const minutes = parseInt(btn.dataset.minutes);
    pauseDomain(minutes);
  });
});

// Initialize on popup open
document.addEventListener("DOMContentLoaded", () => {
  loadDomainStatus();
});