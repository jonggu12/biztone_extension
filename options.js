function load() {
  chrome.storage.sync.get(["OPENAI_API_KEY", "OPENAI_MODEL", "GUARD_MODE"], (res) => {
    if (res.OPENAI_API_KEY) {
      document.getElementById("apiKey").value = res.OPENAI_API_KEY;
      // API 키가 있으면 배너 숨기기
      hideApiKeyBanner();
    } else {
      // API 키가 없으면 배너 표시
      showApiKeyBanner();
    }
    
    if (res.OPENAI_MODEL) document.getElementById("model").value = res.OPENAI_MODEL;
    if (res.GUARD_MODE) document.getElementById("guardMode").value = res.GUARD_MODE;
    else document.getElementById("guardMode").value = "warn"; // 기본값: 경고 모드 (권장)
  });
}

/**
 * API 키 배너를 숨기는 함수 (부드러운 애니메이션)
 */
function hideApiKeyBanner() {
  const banner = document.getElementById("apiKeyBanner");
  if (banner && !banner.classList.contains("hidden")) {
    banner.classList.add("hidden");
    console.debug("[BizTone Settings] API key banner hidden");
  }
}

/**
 * API 키 배너를 표시하는 함수 (부드러운 애니메이션)
 */
function showApiKeyBanner() {
  const banner = document.getElementById("apiKeyBanner");
  if (banner && banner.classList.contains("hidden")) {
    banner.classList.remove("hidden");
    console.debug("[BizTone Settings] API key banner shown");
  }
}

function save() {
  let apiKey = document.getElementById("apiKey").value.trim();
  apiKey = apiKey.replace(/^(["']+)|(["']+)$/g, "").trim();
  const model = document.getElementById("model").value;
  const guardMode = document.getElementById("guardMode").value;
  
  chrome.storage.sync.set({ 
    OPENAI_API_KEY: apiKey, 
    OPENAI_MODEL: model,
    GUARD_MODE: guardMode
  }, () => {
    alert("저장되었습니다.");
    
    // API 키 상태에 따라 배너 표시/숨김
    if (apiKey && apiKey.startsWith("sk-")) {
      hideApiKeyBanner();
    } else {
      showApiKeyBanner();
    }
  });
}

document.getElementById("save").addEventListener("click", save);
document.addEventListener("DOMContentLoaded", load);

// API 키 입력 필드 변경 감지
document.getElementById("apiKey").addEventListener("input", (e) => {
  const apiKey = e.target.value.trim();
  
  // 실시간으로 배너 상태 업데이트
  if (apiKey && apiKey.startsWith("sk-") && apiKey.length > 20) {
    hideApiKeyBanner();
  } else {
    showApiKeyBanner();
  }
});

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

// ==================== DOMAIN MANAGEMENT ====================

/**
 * Load and display domain rules
 */
async function loadDomainRules() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_DOMAIN_RULES'
    });
    
    if (response?.ok && response.result) {
      displayDomainRules(response.result);
    } else {
      console.error('Failed to load domain rules');
    }
  } catch (error) {
    console.error('Error loading domain rules:', error);
  }
}

/**
 * Display domain rules in the UI
 */
function displayDomainRules(rules) {
  const container = document.getElementById('domainList');
  
  if (Object.keys(rules).length === 0) {
    container.innerHTML = '<div class="muted">등록된 도메인이 없습니다.</div>';
    return;
  }
  
  let html = '<div style="margin-bottom: 10px; font-weight: 600; color: #374151;">등록된 도메인</div>';
  
  Object.entries(rules).forEach(([domain, rule]) => {
    const now = Date.now();
    const paused = rule.pauseUntil && rule.pauseUntil > now;
    const pauseRemaining = paused ? Math.ceil((rule.pauseUntil - now) / (60 * 1000)) : 0;
    
    let statusText, statusColor;
    if (paused) {
      statusText = `⏸️ ${pauseRemaining}분 일시중지`;
      statusColor = '#f59e0b';
    } else if (rule.enabled !== false) {
      statusText = '✅ 활성';
      statusColor = '#10b981';
    } else {
      statusText = '🔇 비활성';
      statusColor = '#ef4444';
    }
    
    html += `
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 8px; background: #f9fafb;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <div style="font-weight: 600; color: #111827;">${domain}</div>
            <div style="font-size: 12px; color: ${statusColor}; margin-top: 2px;">${statusText}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="toggle-domain-btn" data-domain="${domain}" style="font-size: 11px; padding: 4px 8px;">
              ${rule.enabled !== false ? '끄기' : '켜기'}
            </button>
            <button class="remove-domain-btn" data-domain="${domain}" style="font-size: 11px; padding: 4px 8px; background: #ef4444; color: white;">
              삭제
            </button>
          </div>
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
  
  // Add event listeners to dynamically created buttons
  container.querySelectorAll('.toggle-domain-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const domain = button.getAttribute('data-domain');
      await toggleDomainRule(domain);
    });
  });
  
  container.querySelectorAll('.remove-domain-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const domain = button.getAttribute('data-domain');
      await removeDomainRule(domain);
    });
  });
}

/**
 * Add new domain rule
 */
async function addDomainRule() {
  const input = document.getElementById('domainInput');
  const domain = input.value.trim().toLowerCase();
  
  if (!domain) {
    alert('도메인을 입력해주세요.');
    return;
  }
  
  // Basic domain validation
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    alert('올바른 도메인 형식을 입력해주세요. (예: slack.com)');
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_SET_DOMAIN_RULE',
      domain: domain,
      options: { enabled: true }
    });
    
    if (response?.ok) {
      input.value = '';
      loadDomainRules();
      setStatus(`${domain} 도메인이 추가되었습니다.`, true);
    } else {
      alert('도메인 추가에 실패했습니다.');
    }
  } catch (error) {
    console.error('Error adding domain rule:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Toggle domain rule
 */
async function toggleDomainRule(domain) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_TOGGLE_DOMAIN',
      domain: domain
    });
    
    if (response?.ok) {
      loadDomainRules();
      const action = response.result.enabled ? '활성화' : '비활성화';
      setStatus(`${domain}가 ${action}되었습니다.`, true);
    } else {
      alert('도메인 설정 변경에 실패했습니다.');
    }
  } catch (error) {
    console.error('Error toggling domain rule:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Remove domain rule
 */
async function removeDomainRule(domain) {
  if (!confirm(`${domain} 도메인 설정을 삭제하시겠습니까?`)) {
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_REMOVE_DOMAIN_RULE',
      domain: domain
    });
    
    if (response?.ok) {
      loadDomainRules();
      setStatus(`${domain} 도메인이 삭제되었습니다.`, true);
    } else {
      alert('도메인 삭제에 실패했습니다.');
    }
  } catch (error) {
    console.error('Error removing domain rule:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

// Event listeners
document.getElementById('addDomain').addEventListener('click', addDomainRule);
document.getElementById('domainInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    addDomainRule();
  }
});

// Load domain rules on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    loadDomainRules();
  }, 100);
});

// 배너 기능 구현
document.getElementById("openDashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://platform.openai.com/" });
});

document.getElementById("openGuide").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://platform.openai.com/docs/quickstart" });
});


// Guard mode save button
document.getElementById("saveGuardMode").addEventListener("click", () => {
  const guardMode = document.getElementById("guardMode").value;
  chrome.storage.sync.set({ GUARD_MODE: guardMode }, () => {
    setStatus("감지 모드가 저장되었습니다.", true);
    setTimeout(() => setStatus(""), 2000);
  });
});
