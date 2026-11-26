<template>
  <div v-if="visible" class="modal-backdrop" @click.self="onClose">
    <div class="modal-dialog" :style="dialogStyle">
      <header class="modal-header">
        <div class="modal-header-main">
          <slot name="header">
            <span class="modal-title">{{ title }}</span>
          </slot>
        </div>
        <div class="modal-header-actions">
          <slot name="header-actions" />
          <button type="button" class="base-close-btn" @click="onClose">닫기</button>
        </div>
      </header>

      <div class="modal-body" :style="bodyStyle">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="modal-footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  visible: {
    type: Boolean,
    default: false
  },
  title: {
    type: String,
    default: ''
  },
  maxWidth: {
    type: String,
    default: '820px'
  },
  maxHeight: {
    type: String,
    default: '88vh'
  },
  bodyGap: {
    type: String,
    default: '10px'
  }
});

const emit = defineEmits(['close']);

const dialogStyle = computed(() => ({
  width: `min(${props.maxWidth}, 95vw)`,
  maxHeight: props.maxHeight
}));

const bodyStyle = computed(() => ({
  gap: props.bodyGap
}));

function onClose() {
  emit('close');
}
</script>

<style lang="scss" scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(8, 11, 16, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-dialog {
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
  gap: 10px;
}

.modal-header-main {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 700;
  color: $text-primary;
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.base-close-btn {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid $border-strong;
  background-color: $bg-elevated;
  color: $text-primary;
  font-size: 11px;
  cursor: pointer;

  &:hover {
    background-color: $bg-hover;
  }
}

.modal-body {
  padding: 14px 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.modal-footer {
  padding: 10px 16px;
  background-color: $bg-header;
  border-top: 1px solid $border-subtle;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
</style>
