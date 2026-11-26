<template>
  <BaseModal
    :visible="Boolean(modalData.visible && modalData.handover)"
    :title="modalData.handover ? `세션 인수인계서 생성 완료 — ${modalData.handover.agentId} (${modalData.handover.healthLabel}, ${modalData.handover.fileSizeMB}MB)` : ''"
    max-width="820px"
    max-height="88vh"
    body-gap="0px"
    @close="closeModal"
  >
    <div v-if="modalData.handover">
      <div class="modal-desc">
        표준 규격(<code>SESSION_HANDOVER_TEMPLATE.md</code>)에 따라 아래 경로에 저장했습니다.
      </div>
      <div class="path-box">{{ modalData.handover.filePath }}</div>
      <div class="section-label">문서 내용</div>
      <pre class="doc-pre">{{ modalData.handover.content }}</pre>
      <div v-if="copyFeedback" class="copy-feedback">{{ copyFeedback }}</div>
    </div>

    <template #footer>
      <button type="button" class="btn btn-warn" @click="copyText(modalData.handover.agentRefinePrompt, '보완 지시문')">
        보완 지시문 복사
      </button>
      <button type="button" class="btn btn-primary" @click="copyText(modalData.handover.bootstrapPrompt, '새 세션 프롬프트')">
        새 세션 프롬프트 복사
      </button>
      <button
        v-if="modalData.handover && modalData.handover.convId"
        type="button"
        class="btn"
        title="정리가 끝난 이 세션을 보관(숨김) 상태로 전환"
        @click="archiveHandoverSession"
      >
        이 세션 보관(정리 완료)
      </button>
      <button type="button" class="btn" @click="closeModal">닫기</button>
    </template>
  </BaseModal>
</template>

<script setup>
import { ref } from 'vue';
import BaseModal from '@/components/BaseModal.vue';

const props = defineProps({
  modalData: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);
const copyFeedback = ref('');

function closeModal() {
  copyFeedback.value = '';
  emit('action', { type: 'CLOSE_MODAL' });
}

function archiveHandoverSession() {
  const handover = props.modalData && props.modalData.handover;
  if (!handover || !handover.convId) return;
  emit('action', {
    type: 'UPDATE_SESSION_META',
    payload: { convId: handover.convId, archived: true }
  });
  copyFeedback.value = '이 세션을 정리됨(보관) 상태로 전환했습니다.';
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
