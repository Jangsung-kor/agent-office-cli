<template>
  <div v-if="visible && handover" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-dialog">
      <header class="modal-header">
        <span class="modal-title">
          세션 인수인계서 생성 완료 — {{ handover.agentId }} ({{ handover.healthLabel }}, {{ handover.fileSizeMB }}MB)
        </span>
        <button type="button" class="btn btn-sm" @click="closeModal">닫기</button>
      </header>

      <div class="modal-body">
        <div class="modal-desc">
          표준 규격(<code>SESSION_HANDOVER_TEMPLATE.md</code>)에 따라 아래 경로에 저장했습니다.
        </div>
        <div class="path-box">{{ handover.filePath }}</div>
        <div class="section-label">문서 내용</div>
        <pre class="doc-pre">{{ handover.content }}</pre>
        <div v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</div>
      </div>

      <footer class="modal-footer">
        <button type="button" class="btn btn-warn" @click="copyText(handover.agentRefinePrompt, '보완 지시문')">
          보완 지시문 복사
        </button>
        <button type="button" class="btn btn-primary" @click="copyText(handover.bootstrapPrompt, '새 세션 프롬프트')">
          새 세션 프롬프트 복사
        </button>
        <button type="button" class="btn" @click="closeModal">닫기</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  handover: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['action']);
const copyFeedback = ref('');

function closeModal() {
  copyFeedback.value = '';
  emit('action', { type: 'CLOSE_MODAL' });
}

async function copyText(text, label) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.value = `${label}이(가) 클립보드에 복사되었습니다.`;
  } catch (_) {
    copyFeedback.value = '클립보드 복사 권한을 확인해 주세요.';
  }
}
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(8, 11, 16, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-dialog {
  width: min(820px, 92vw);
  max-height: 88vh;
  background-color: $bg-surface;
  border: 1px solid $border-strong;
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  padding: 12px 16px;
  background-color: $bg-header;
  border-bottom: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-title {
  font-size: 13.5px;
  font-weight: 600;
  color: $text-primary;
}

.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal-desc {
  font-size: 12px;
  color: $text-secondary;
}

.path-box {
  padding: 8px 11px;
  background-color: $bg-input;
  border: 1px solid $border-subtle;
  border-left: 3px solid $state-done;
  border-radius: 4px;
  font-family: $font-mono;
  font-size: 11.5px;
  color: $term-green;
  word-break: break-all;
}

.section-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-secondary;
}

.doc-pre {
  background-color: $term-bg;
  border: 1px solid $border-subtle;
  border-radius: 4px;
  padding: 10px 12px;
  font-family: $font-mono;
  font-size: 11.5px;
  line-height: 1.55;
  color: $text-primary;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 340px;
  overflow-y: auto;
}

.copy-feedback {
  font-size: 12px;
  color: $term-green;
}

.modal-footer {
  padding: 10px 16px;
  background-color: $bg-header;
  border-top: 1px solid $border-subtle;
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}

.btn {
  padding: 6px 13px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 12px;
  cursor: pointer;
}

.btn-sm {
  padding: 4px 9px;
  font-size: 11px;
}

.btn-primary {
  background-color: $navy-accent;
  border-color: $navy-border;
}

.btn-warn {
  background-color: rgba(180, 83, 9, 0.22);
  border-color: $term-warn;
  color: $term-yellow;
}
</style>
