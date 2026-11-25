<template>
  <div v-if="visible" class="modal-backdrop" @click.self="closeModal">
    <div class="modal-dialog">
      <header class="modal-header">
        <span class="modal-title">AI 모델별 성능 및 추론 강도 안내</span>
        <button type="button" class="btn btn-sm" @click="closeModal">닫기</button>
      </header>

      <div class="modal-body">
        <p class="modal-desc">
          작업 난이도와 응답 속도, 토큰 소모량을 기준으로 적합한 모델과 추론 강도(--effort)를 선택하세요.
        </p>

        <div class="section-title">1. 모델 계열별 특성 비교</div>
        <table class="guide-table">
          <thead>
            <tr>
              <th>모델 계열</th>
              <th>성능</th>
              <th>속도</th>
              <th>토큰 사용량</th>
              <th>권장 용도</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Gemini 4 Carbon</strong></td>
              <td>최상</td>
              <td>느림</td>
              <td>높음</td>
              <td>고난도 아키텍처 설계, 보안 감사, 장기 복합 추론</td>
            </tr>
            <tr>
              <td><strong>Gemini 4 Neon</strong></td>
              <td>상 ~ 최상</td>
              <td>보통 ~ 빠름</td>
              <td>중간 ~ 높음</td>
              <td>지표 분석과 응답 속도를 함께 요구하는 핵심 개발</td>
            </tr>
            <tr>
              <td><strong>Gemini 4 Argon</strong></td>
              <td>상</td>
              <td>보통</td>
              <td>중간</td>
              <td>Carbon 대비 적은 토큰으로 복합 엔지니어링 처리</td>
            </tr>
            <tr>
              <td><strong>Gemini 4 Hydrogen</strong></td>
              <td>중상</td>
              <td>빠름</td>
              <td>낮음 ~ 중간</td>
              <td>일상 코딩, 반복 구현, 에이전트 실무 실행</td>
            </tr>
            <tr>
              <td><strong>Gemini 3.8 Flash</strong></td>
              <td>중</td>
              <td>매우 빠름</td>
              <td>낮음</td>
              <td>단순 파일 조회, 로그 요약, 간단한 문구·스타일 수정</td>
            </tr>
            <tr>
              <td><strong>Claude Sonnet 5.5</strong></td>
              <td>상</td>
              <td>빠름</td>
              <td>중간</td>
              <td>Vue·Java 실무 코딩, 컨벤션 준수 리뷰 및 패치</td>
            </tr>
            <tr>
              <td><strong>Claude Opus 5.5</strong></td>
              <td>최상</td>
              <td>느림</td>
              <td>매우 높음</td>
              <td>대규모 리팩토링, 까다로운 결함 근본 원인 분석</td>
            </tr>
            <tr>
              <td><strong>GPT-OSS 120B</strong></td>
              <td>중상</td>
              <td>보통</td>
              <td>중간</td>
              <td>범용 코드 질의 및 보조 분석 작업</td>
            </tr>
          </tbody>
        </table>

        <div class="section-title">2. 추론 강도(--effort) 단계별 차이</div>
        <table class="guide-table">
          <thead>
            <tr>
              <th>등급</th>
              <th>Thinking 토큰</th>
              <th>특징 및 권장 상황</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>low</strong></td>
              <td>최소</td>
              <td>사전 추론 최소화. 단순 조회·단발성 질문에 적합</td>
            </tr>
            <tr>
              <td><strong>medium</strong></td>
              <td>보통</td>
              <td>속도와 정확도의 균형. 일반적인 기능 추가·결함 수정</td>
            </tr>
            <tr>
              <td><strong>high</strong></td>
              <td>높음</td>
              <td>코드 영향도와 엣지 케이스 검증을 포함한 실무 구현 기본값</td>
            </tr>
            <tr>
              <td><strong>xhigh / max</strong></td>
              <td>최대</td>
              <td>깊은 아키텍처 설계 및 다중 파일 수정 시 사용 (대기 시간 증가)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <footer class="modal-footer">
        <button type="button" class="btn btn-primary" @click="closeModal">확인</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
defineProps({
  visible: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['action']);

function closeModal() {
  emit('action', { type: 'CLOSE_MODAL' });
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
  max-height: 86vh;
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
  font-size: 14px;
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

.section-title {
  font-size: 11.5px;
  font-weight: 700;
  color: $term-blue;
  margin-top: 4px;
}

.guide-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;

  th,
  td {
    padding: 7px 9px;
    border-bottom: 1px solid $border-subtle;
    text-align: left;
    vertical-align: top;
  }

  th {
    background-color: $bg-elevated;
    color: $text-secondary;
    font-weight: 600;
  }

  td {
    color: $text-primary;
  }
}

.modal-footer {
  padding: 10px 16px;
  background-color: $bg-header;
  border-top: 1px solid $border-subtle;
  display: flex;
  justify-content: center;
  gap: 8px;
}

.btn {
  padding: 6px 14px;
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
</style>
