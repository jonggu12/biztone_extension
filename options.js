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

// ==================== WHITELIST/BLACKLIST MANAGEMENT ====================

/**
 * Load and display whitelist items
 */
async function loadWhitelist() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_WHITELIST'
    });
    
    if (response?.ok && response.result) {
      displayWhitelistItems(response.result.whitelist || []);
    } else {
      console.error('Failed to load whitelist');
    }
  } catch (error) {
    console.error('Error loading whitelist:', error);
  }
}

/**
 * Load and display blacklist items
 */
async function loadBlacklist() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_BLACKLIST'
    });
    
    if (response?.ok && response.result) {
      displayBlacklistItems(response.result.blacklist || []);
    } else {
      console.error('Failed to load blacklist');
    }
  } catch (error) {
    console.error('Error loading blacklist:', error);
  }
}

/**
 * Display whitelist items in the UI
 */
function displayWhitelistItems(items) {
  const container = document.getElementById('whitelistItems');
  
  if (items.length === 0) {
    container.innerHTML = '<div class="list-empty">등록된 허용 표현이 없습니다.</div>';
    return;
  }
  
  let html = '';
  items.forEach(item => {
    html += createListItemHTML(item, 'whitelist');
  });
  
  container.innerHTML = html;
  
  // Add event listeners
  container.querySelectorAll('.remove-whitelist-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-id');
      await removeWhitelistItem(itemId);
    });
  });
}

/**
 * Display blacklist items in the UI
 */
function displayBlacklistItems(items) {
  const container = document.getElementById('blacklistItems');
  
  if (items.length === 0) {
    container.innerHTML = '<div class="list-empty">등록된 금지 표현이 없습니다.</div>';
    return;
  }
  
  let html = '';
  items.forEach(item => {
    html += createListItemHTML(item, 'blacklist');
  });
  
  container.innerHTML = html;
  
  // Add event listeners
  container.querySelectorAll('.remove-blacklist-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const itemId = button.getAttribute('data-id');
      await removeBlacklistItem(itemId);
    });
  });
}

/**
 * Create HTML for a list item (whitelist or blacklist)
 */
function createListItemHTML(item, type) {
  const matchLabel = {
    exact: '정확일치',
    contains: '포함',
    regex: '정규식'
  }[item.match] || item.match;
  
  const localeLabel = {
    ko: '한국어',
    en: '영어',
    all: '모든언어'
  }[item.locale] || item.locale;
  
  const weightDisplay = type === 'blacklist' ? 
    `<span class="list-item-tag weight-${item.weight}">위험도 +${item.weight}</span>` : '';
  
  return `
    <div class="list-item">
      <div class="list-item-content">
        <div class="list-item-text">${escapeHtml(item.text)}</div>
        <div class="list-item-meta">
          <span class="list-item-tag match-${item.match}">${matchLabel}</span>
          <span class="list-item-tag locale-${item.locale}">${localeLabel}</span>
          ${weightDisplay}
          <span style="color: #9ca3af;">ID: ${item.id.substring(0, 8)}</span>
        </div>
      </div>
      <div class="list-item-actions">
        <button class="remove-${type}-btn" data-id="${item.id}">삭제</button>
      </div>
    </div>
  `;
}

/**
 * Add whitelist item
 */
async function addWhitelistItem() {
  const text = document.getElementById('whitelistText').value.trim();
  const match = document.getElementById('whitelistMatch').value;
  const locale = document.getElementById('whitelistLocale').value;
  
  if (!text) {
    alert('허용할 표현을 입력해주세요.');
    return;
  }
  
  const item = {
    id: generateId(),
    text,
    match,
    locale,
    createdAt: Date.now()
  };
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_ADD_WHITELIST_ITEM',
      item
    });
    
    if (response?.ok) {
      document.getElementById('whitelistText').value = '';
      loadWhitelist();
      setStatus(`"${text}" 표현이 화이트리스트에 추가되었습니다.`, true);
    } else {
      alert('화이트리스트 추가에 실패했습니다. (중복되거나 유효하지 않음)');
    }
  } catch (error) {
    console.error('Error adding whitelist item:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Add blacklist item
 */
async function addBlacklistItem() {
  const text = document.getElementById('blacklistText').value.trim();
  const match = document.getElementById('blacklistMatch').value;
  const weight = parseInt(document.getElementById('blacklistWeight').value);
  const locale = document.getElementById('blacklistLocale').value;
  
  if (!text) {
    alert('금지할 표현을 입력해주세요.');
    return;
  }
  
  const item = {
    id: generateId(),
    text,
    match,
    weight,
    locale,
    createdAt: Date.now()
  };
  
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_ADD_BLACKLIST_ITEM',
      item
    });
    
    if (response?.ok) {
      document.getElementById('blacklistText').value = '';
      loadBlacklist();
      setStatus(`"${text}" 표현이 블랙리스트에 추가되었습니다.`, true);
    } else {
      alert('블랙리스트 추가에 실패했습니다. (중복되거나 유효하지 않음)');
    }
  } catch (error) {
    console.error('Error adding blacklist item:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Remove whitelist item
 */
async function removeWhitelistItem(itemId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_REMOVE_WHITELIST_ITEM',
      itemId
    });
    
    if (response?.ok) {
      loadWhitelist();
      setStatus('화이트리스트 항목이 삭제되었습니다.', true);
    } else {
      alert('화이트리스트 삭제에 실패했습니다.');
    }
  } catch (error) {
    console.error('Error removing whitelist item:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Remove blacklist item
 */
async function removeBlacklistItem(itemId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_REMOVE_BLACKLIST_ITEM',
      itemId
    });
    
    if (response?.ok) {
      loadBlacklist();
      setStatus('블랙리스트 항목이 삭제되었습니다.', true);
    } else {
      alert('블랙리스트 삭제에 실패했습니다.');
    }
  } catch (error) {
    console.error('Error removing blacklist item:', error);
    alert('연결 오류가 발생했습니다.');
  }
}

/**
 * Export whitelist to JSON
 */
async function exportWhitelist() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_WHITELIST'
    });
    
    if (response?.ok && response.result) {
      const data = {
        type: 'BIZTONE_WHITELIST',
        version: '1.0',
        exportDate: new Date().toISOString(),
        items: response.result.whitelist || []
      };
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `biztone-whitelist-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus('화이트리스트가 JSON 파일로 내보내졌습니다.', true);
    }
  } catch (error) {
    console.error('Error exporting whitelist:', error);
    alert('내보내기에 실패했습니다.');
  }
}

/**
 * Export blacklist to JSON
 */
async function exportBlacklist() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'BIZTONE_GET_BLACKLIST'
    });
    
    if (response?.ok && response.result) {
      const data = {
        type: 'BIZTONE_BLACKLIST',
        version: '1.0',
        exportDate: new Date().toISOString(),
        items: response.result.blacklist || []
      };
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `biztone-blacklist-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setStatus('블랙리스트가 JSON 파일로 내보내졌습니다.', true);
    }
  } catch (error) {
    console.error('Error exporting blacklist:', error);
    alert('내보내기에 실패했습니다.');
  }
}

/**
 * Import whitelist from JSON file
 */
function importWhitelist(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      if (data.type !== 'BIZTONE_WHITELIST' || !Array.isArray(data.items)) {
        alert('유효하지 않은 화이트리스트 파일입니다.');
        return;
      }
      
      const response = await chrome.runtime.sendMessage({
        type: 'BIZTONE_SET_WHITELIST',
        whitelist: data.items
      });
      
      if (response?.ok) {
        loadWhitelist();
        setStatus(`${data.items.length}개의 화이트리스트 항목을 가져왔습니다.`, true);
      } else {
        alert('화이트리스트 가져오기에 실패했습니다.');
      }
    } catch (error) {
      console.error('Error importing whitelist:', error);
      alert('파일 형식이 올바르지 않습니다.');
    }
  };
  reader.readAsText(file);
  
  // Reset file input
  event.target.value = '';
}

/**
 * Import blacklist from JSON file
 */
function importBlacklist(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      if (data.type !== 'BIZTONE_BLACKLIST' || !Array.isArray(data.items)) {
        alert('유효하지 않은 블랙리스트 파일입니다.');
        return;
      }
      
      const response = await chrome.runtime.sendMessage({
        type: 'BIZTONE_SET_BLACKLIST',
        blacklist: data.items
      });
      
      if (response?.ok) {
        loadBlacklist();
        setStatus(`${data.items.length}개의 블랙리스트 항목을 가져왔습니다.`, true);
      } else {
        alert('블랙리스트 가져오기에 실패했습니다.');
      }
    } catch (error) {
      console.error('Error importing blacklist:', error);
      alert('파일 형식이 올바르지 않습니다.');
    }
  };
  reader.readAsText(file);
  
  // Reset file input
  event.target.value = '';
}

/**
 * Generate unique ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event listeners for whitelist/blacklist management
document.getElementById('addWhitelistItem').addEventListener('click', addWhitelistItem);
document.getElementById('addBlacklistItem').addEventListener('click', addBlacklistItem);

document.getElementById('whitelistText').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    addWhitelistItem();
  }
});

document.getElementById('blacklistText').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    addBlacklistItem();
  }
});

// Export/Import functionality
document.getElementById('exportWhitelist').addEventListener('click', exportWhitelist);
document.getElementById('exportBlacklist').addEventListener('click', exportBlacklist);

document.getElementById('importWhitelist').addEventListener('click', () => {
  document.getElementById('whitelistFileInput').click();
});

document.getElementById('importBlacklist').addEventListener('click', () => {
  document.getElementById('blacklistFileInput').click();
});

document.getElementById('whitelistFileInput').addEventListener('change', importWhitelist);
document.getElementById('blacklistFileInput').addEventListener('change', importBlacklist);

// Load whitelist/blacklist on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    loadWhitelist();
    loadBlacklist();
  }, 150);
});

// ==================== FEEDBACK SYSTEM ====================

/**
 * Send feedback via email
 */
function sendFeedback() {
  const feedbackData = {
    type: "feedback",
    version: "1.0",
    timestamp: new Date().toISOString(),
    systemInfo: {
      extension_version: "2.0",
      browser: navigator.userAgent,
      locale: navigator.language,
      url: "Extension Settings Page"
    }
  };
  
  const subject = "[BizTone] 사용자 피드백";
  const body = `
안녕하세요, BizTone 개발팀입니다.

다음 양식에 맞춰 피드백을 작성해주세요:

=== 피드백 정보 ===
□ 문제 유형: [오탐/누락/변환품질/UI버그/기능요청/기타]
□ 문제 설명: [구체적인 상황 설명]
□ 예시 텍스트: [문제가 발생한 텍스트가 있다면]
□ 재현 단계: [문제 재현 방법]
□ 기대 결과: [어떻게 동작하길 원하는지]

=== 연락처 정보 ===
□ 이메일: [답변 받을 이메일 주소]
□ 연락 희망 여부: [예/아니오]

=== 시스템 정보 (자동 생성) ===
확장프로그램 버전: ${feedbackData.systemInfo.extension_version}
브라우저: ${feedbackData.systemInfo.browser}
언어: ${feedbackData.systemInfo.locale}
작성 시간: ${feedbackData.timestamp}

=== 추가 정보 ===
※ 필요시 스크린샷이나 로그 파일을 첨부해주세요.
※ 개인정보가 포함된 내용은 마스킹 후 전송해주세요.

감사합니다!
`;

  const mailtoLink = `mailto:support@biztone.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  
  try {
    window.open(mailtoLink);
    setStatus('피드백 양식이 이메일 클라이언트에서 열렸습니다.', true);
  } catch (error) {
    console.error('Error opening email client:', error);
    // fallback: 텍스트 복사
    copyFeedbackToClipboard(subject + '\n\n' + body);
  }
}

/**
 * Copy feedback template to clipboard as fallback
 */
function copyFeedbackToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      alert('피드백 양식이 클립보드에 복사되었습니다.\n이메일로 support@biztone.com에 전송해주세요.');
    }).catch(() => {
      showFeedbackModal(text);
    });
  } else {
    showFeedbackModal(text);
  }
}

/**
 * Show feedback in modal as final fallback
 */
function showFeedbackModal(text) {
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.7); z-index: 10000; display: flex;
    align-items: center; justify-content: center;
  `;
  
  modal.innerHTML = `
    <div style="background: white; padding: 20px; border-radius: 12px; max-width: 80%; max-height: 80%; overflow-y: auto;">
      <h3>피드백 양식</h3>
      <p>다음 내용을 복사하여 <strong>support@biztone.com</strong>으로 이메일 전송해주세요:</p>
      <textarea readonly style="width: 100%; height: 300px; font-family: monospace; font-size: 12px; border: 1px solid #ccc; padding: 10px;">${text}</textarea>
      <div style="margin-top: 15px; text-align: right;">
        <button onclick="this.closest('div').parentElement.remove()" style="padding: 8px 16px; background: #111827; color: white; border: none; border-radius: 6px; cursor: pointer;">닫기</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
}

/**
 * View logs (placeholder for future implementation)
 */
function viewLogs() {
  alert('로그 기능은 향후 업데이트에서 제공될 예정입니다.\n\n현재는 피드백 보내기를 통해 문제를 신고해주세요.');
}

// Event listeners for feedback system
document.getElementById('sendFeedback').addEventListener('click', sendFeedback);
document.getElementById('viewLogs').addEventListener('click', viewLogs);
