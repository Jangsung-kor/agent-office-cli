<template>
  <section class="stage-container">
    <div ref="frameRef" class="canvas-frame">
      <canvas
        ref="canvasRef"
        class="office-canvas"
        @mousemove="onMouseMove"
        @mouseleave="onMouseLeave"
        @click="onCanvasClick"
      ></canvas>
    </div>

    <div class="stage-footer">
      <div class="stage-legend">
        <div v-for="item in legendItems" :key="item.key" class="legend-item">
          <span :class="['legend-dot', `dot-${item.key}`]"></span>
          <span>{{ item.label }}</span>
        </div>
      </div>
      <div class="stage-hint">에이전트 클릭 시 우측 터미널 제어</div>
    </div>
  </section>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';
import {
  LOGICAL_WIDTH,
  LOGICAL_HEIGHT,
  STATE_META,
  buildResponsiveOfficeSpec,
  assignAgentSeats,
  getHealthMeta
} from '@/constants/officeLayout';

const props = defineProps({
  canvasState: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['action']);

const frameRef = ref(null);
const canvasRef = ref(null);

const legendItems = [
  { key: 'idle', label: 'IDLE(대기)' },
  { key: 'working', label: 'WORKING(작업중)' },
  { key: 'blocked', label: 'BLOCKED(중단/오류)' },
  { key: 'done', label: 'DONE(완료)' }
];

// 60fps 물리 보간용 로컬 캔버스 상태 (props 원본 불변성 유지)
const renderAgentsMap = new Map();
const renderPackets = [];
const seenPacketIds = new Set();
let currentSpec = buildResponsiveOfficeSpec(LOGICAL_WIDTH, LOGICAL_HEIGHT);
let tickCount = 0;
let rafId = null;
let lastFrameMs = 0;
let resizeObserver = null;
let renderScaleX = 1;
let renderScaleY = 1;

/**
 * 상위 레이아웃으로 단일 액션 전달
 * @author Jangsung
 * @param {String} type
 * @param {Object} payload
 */
function emitAction(type, payload) {
  emit('action', { type, payload });
}

/**
 * 현재 반응형 오피스 레이아웃(currentSpec) 기준으로 에이전트 목표 좌표 동기화
 * @author Jangsung
 * @param {Array<Object>} rawAgents
 * @param {Boolean} snapImmediately
 */
function syncRenderAgents(rawAgents, snapImmediately = false) {
  const positioned = assignAgentSeats(
    rawAgents || [],
    currentSpec
  );
  const activeIds = new Set();

  for (const agent of positioned) {
    activeIds.add(agent.id);
    const prev = renderAgentsMap.get(agent.id);
    if (prev && !snapImmediately) {
      Object.assign(prev, {
        ...agent,
        x: prev.x,
        y: prev.y,
        animPhase: prev.animPhase,
        isMoving: prev.isMoving
      });
    } else {
      renderAgentsMap.set(agent.id, {
        ...agent,
        x: agent.targetX,
        y: agent.targetY,
        animPhase: prev ? prev.animPhase : Math.random() * Math.PI * 2,
        isMoving: false
      });
    }
  }
  for (const id of Array.from(renderAgentsMap.keys())) {
    if (!activeIds.has(id)) {
      renderAgentsMap.delete(id);
    }
  }
}

watch(
  () => props.canvasState.agents,
  nextAgents => {
    syncRenderAgents(nextAgents || [], false);
  },
  { immediate: true, deep: true }
);

watch(
  () => props.canvasState.packets,
  nextPackets => {
    if (!Array.isArray(nextPackets)) return;
    for (const pkt of nextPackets) {
      if (!seenPacketIds.has(pkt.id)) {
        seenPacketIds.add(pkt.id);
        renderPackets.push({ ...pkt, progress: 0 });
      }
    }
  },
  { immediate: true, deep: true }
);

/**
 * 패널 가용 영역에 맞춰 반응형 레이아웃(wide/tall) 및 1:1 물리 픽셀 해상도 동기화
 * @author Jangsung
 */
function resizeCanvas() {
  const frame = frameRef.value;
  const canvas = canvasRef.value;
  if (!frame || !canvas) return;

  const availW = frame.clientWidth;
  const availH = frame.clientHeight;
  if (availW <= 0 || availH <= 0) return;

  const prevMode = currentSpec.mode;
  const nextSpec = buildResponsiveOfficeSpec(availW, availH);
  currentSpec = nextSpec;

  const dpr = window.devicePixelRatio || 1;
  const aspect = nextSpec.width / nextSpec.height;
  let displayW = availW;
  let displayH = displayW / aspect;
  if (displayH > availH) {
    displayH = availH;
    displayW = displayH * aspect;
  }

  const cssW = Math.max(1, Math.floor(displayW));
  const cssH = Math.max(1, Math.floor(displayH));
  const pixelW = Math.max(1, Math.round(cssW * dpr));
  const pixelH = Math.max(1, Math.round(cssH * dpr));

  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = pixelW;
  canvas.height = pixelH;

  renderScaleX = pixelW / nextSpec.width;
  renderScaleY = pixelH / nextSpec.height;

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(renderScaleX, 0, 0, renderScaleY, 0, 0);
  }

  // 레이아웃 모드 전환 또는 세로 높이 변경 시 즉시 좌석 좌표 재정렬 후 동기 렌더(깜빡임 방지)
  syncRenderAgents(props.canvasState.agents || [], prevMode !== nextSpec.mode || nextSpec.mode === 'tall');
  if (ctx) {
    renderScene(ctx);
  }
}

/**
 * 클라이언트 좌표를 현재 레이아웃의 논리 좌표로 변환
 * @author Jangsung
 * @param {Number} clientX
 * @param {Number} clientY
 * @return {Object}
 */
function getLogicalPos(clientX, clientY) {
  const canvas = canvasRef.value;
  if (!canvas) return { x: -1, y: -1 };
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { x: -1, y: -1 };
  return {
    x: ((clientX - rect.left) / rect.width) * currentSpec.width,
    y: ((clientY - rect.top) / rect.height) * currentSpec.height
  };
}

/**
 * 논리 좌표에 위치한 에이전트 히트테스트
 * @author Jangsung
 * @param {Number} lx
 * @param {Number} ly
 * @return {Object|null}
 */
function findAgentAt(lx, ly) {
  const list = Array.from(renderAgentsMap.values());
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (Math.abs(lx - a.x) <= 26 && ly >= a.y - 42 && ly <= a.y + 24) {
      return a;
    }
  }
  return null;
}

function onMouseMove(e) {
  const pos = getLogicalPos(e.clientX, e.clientY);
  const hit = findAgentAt(pos.x, pos.y);
  const nextHoverId = hit ? hit.id : null;
  if (canvasRef.value) {
    canvasRef.value.style.cursor = hit ? 'pointer' : 'default';
  }
  if (nextHoverId !== props.canvasState.hoveredAgentId) {
    emitAction('HOVER_AGENT', { agentId: nextHoverId });
  }
}

function onMouseLeave() {
  if (props.canvasState.hoveredAgentId) {
    emitAction('HOVER_AGENT', { agentId: null });
  }
}

function onCanvasClick(e) {
  const pos = getLogicalPos(e.clientX, e.clientY);
  const hit = findAgentAt(pos.x, pos.y);
  if (hit) {
    emitAction('SELECT_AGENT', { agentId: hit.id });
  }
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawFloorGrid(ctx, logicalW, logicalH) {
  ctx.fillStyle = '#0e131b';
  ctx.fillRect(0, 0, logicalW, logicalH);

  ctx.strokeStyle = 'rgba(42, 54, 72, 0.28)';
  ctx.lineWidth = 1;
  const gridSize = 32;
  ctx.beginPath();
  for (let x = 0; x <= logicalW; x += gridSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, logicalH);
  }
  for (let y = 0; y <= logicalH; y += gridSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(logicalW, y);
  }
  ctx.stroke();
}

function drawZones(ctx, zones) {
  Object.values(zones).forEach(z => {
    ctx.fillStyle = z.fill;
    roundRect(ctx, z.x, z.y, z.w, z.h, 6, true, false);

    ctx.strokeStyle = z.border;
    ctx.lineWidth = 1.5;
    roundRect(ctx, z.x, z.y, z.w, z.h, 6, false, true);

    ctx.fillStyle = 'rgba(30, 41, 59, 0.78)';
    ctx.fillRect(z.x + 1, z.y + 1, z.w - 2, 26);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = 'bold 12.5px "Malgun Gothic", "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(z.name, z.x + 12, z.y + 18);

    // 공간 헤더 이름 우측에 해당 구역에 머무는 상태 도트 아이콘 및 라벨 표출
    const chips = Array.isArray(z.statusChips) ? z.statusChips : [];
    if (chips.length > 0) {
      let cx = Math.round(z.x + 12 + ctx.measureText(z.name).width + 14);
      const cy = z.y + 14;
      ctx.font = 'bold 11px Consolas, "Malgun Gothic", sans-serif';
      for (const chip of chips) {
        const labelW = ctx.measureText(chip.label).width;
        if (cx + 12 + labelW > z.x + z.w - 8) break;

        ctx.fillStyle = chip.color;
        ctx.beginPath();
        ctx.arc(cx + 4, cy, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(chip.label, Math.round(cx + 12), z.y + 18);
        cx = Math.round(cx + 12 + labelW + 10);
      }
    }
  });
}

function drawMonitor(ctx, cx, cy, w, h, glowColor) {
  ctx.fillStyle = '#090d14';
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.fillRect(cx - w / 2, cy, w, h);
  ctx.strokeRect(cx - w / 2, cy, w, h);

  ctx.fillStyle = glowColor;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(cx - w / 2 + 4, cy + 4, w * 0.55, 2);
  ctx.fillRect(cx - w / 2 + 4, cy + 8, w * 0.72, 2);
  ctx.globalAlpha = 1;
}

function drawDeskWithMonitor(ctx, cx, cy, accentColor) {
  const w = 98;
  const h = 38;
  const x = cx - w / 2;
  const y = cy - h / 2;

  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  roundRect(ctx, x + 3, y + 4, w, h, 4, true, false);

  ctx.fillStyle = '#1f2937';
  ctx.strokeStyle = '#374151';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, w, h, 4, true, true);

  drawMonitor(ctx, cx, y + 8, 46, 15, accentColor);

  ctx.fillStyle = '#111827';
  ctx.fillRect(cx - 16, y + h - 11, 32, 6);
}

function drawCoffeeMachine(ctx, x, y) {
  ctx.fillStyle = '#1b2432';
  ctx.strokeStyle = '#314054';
  roundRect(ctx, x, y, 54, 42, 4, true, true);
  ctx.fillStyle = '#334155';
  ctx.fillRect(x + 12, y + 8, 18, 22);
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(x + 17, y + 12, 8, 4);
  ctx.fillStyle = '#475569';
  ctx.fillRect(x + 36, y + 16, 10, 14);
}

/**
 * 지정된 픽셀 폭에 맞게 캔버스 텍스트를 말줄임 처리
 * @author Jangsung
 * @param {CanvasRenderingContext2D} ctx
 * @param {String} text
 * @param {Number} maxWidth
 * @return {String}
 */
function fitTextToWidth(ctx, text, maxWidth) {
  const str = String(text || '');
  if (!str || ctx.measureText(str).width <= maxWidth) return str;
  const suffix = '..';
  let end = str.length;
  while (end > 1 && ctx.measureText(str.slice(0, end) + suffix).width > maxWidth) {
    end -= 1;
  }
  return end <= 1 ? str.slice(0, 1) : `${str.slice(0, end)}${suffix}`;
}

/**
 * 휴게실 상단 에이전트별 개인 사물함(캐비닛) 렌더링
 * @author Jangsung
 * @param {CanvasRenderingContext2D} ctx
 * @param {Number} x
 * @param {Number} y
 * @param {Number} w
 * @param {Number} h
 * @param {Object} agent
 */
function drawAgentLocker(ctx, x, y, w, h, agent) {
  const meta = STATE_META[agent.state] || STATE_META.IDLE;
  const isSelected = props.canvasState.selectedAgentId === agent.id;

  // 캐비닛 외곽 프레임
  ctx.fillStyle = '#17202e';
  ctx.strokeStyle = isSelected ? '#60a5fa' : '#32445e';
  ctx.lineWidth = isSelected ? 1.4 : 1;
  roundRect(ctx, x, y, w, h, 3, true, true);

  // 상단 팀원 고유 색상 띠
  ctx.fillStyle = agent.shirtColor || '#475569';
  ctx.fillRect(x + 3, y + 3, w - 6, 3);

  // 통풍구 슬릿
  ctx.fillStyle = '#29384d';
  ctx.fillRect(x + 7, y + 10, Math.max(10, w - 20), 2);
  ctx.fillRect(x + 7, y + 14, Math.max(10, w - 20), 2);

  // 우측 손잡이 및 상단 상태 점
  ctx.fillStyle = '#64748b';
  ctx.fillRect(x + w - 8, y + 18, 2.5, 9);
  ctx.fillStyle = meta.color;
  ctx.beginPath();
  ctx.arc(x + w - 7, y + 10, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // 하단 이름표 (실제 사물함 가용 폭 기준 동적 맞춤)
  ctx.fillStyle = '#0f1622';
  ctx.fillRect(x + 3, y + h - 14, w - 6, 11);
  ctx.font = 'bold 9.5px "Malgun Gothic", "Segoe UI", sans-serif';
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  const shortName = fitTextToWidth(ctx, agent.name || agent.id || '', w - 8);
  ctx.fillText(shortName, Math.round(x + w / 2), y + h - 5.5);
}

/**
 * 휴게실 내 활성 에이전트 수에 맞춰 개인 사물함 일렬 배치
 * @author Jangsung
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} lounge
 * @param {Array<Object>} agents
 */
function drawLoungeLockers(ctx, lounge, agents) {
  const count = agents.length;
  if (count === 0) return;

  const startX = lounge.x + 82;
  const availW = Math.max(120, lounge.w - 96);
  const gap = count > 8 ? 6 : 10;
  const lockerW = Math.max(44, Math.min(78, Math.floor((availW - gap * (count - 1)) / count)));
  const totalRowW = count * lockerW + (count - 1) * gap;
  const baseX = Math.round(startX + Math.max(0, (availW - totalRowW) / 2));
  const lockerY = lounge.y + 38;
  const lockerH = 44;

  for (let i = 0; i < count; i++) {
    const lx = baseX + i * (lockerW + gap);
    drawAgentLocker(ctx, lx, lockerY, lockerW, lockerH, agents[i]);
  }
}

function drawMottoPlaque(ctx, x, y, w, compact = false) {
  ctx.save();
  ctx.fillStyle = '#0f1622';
  ctx.strokeStyle = '#334e73';
  ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, w, 30, 4, true, true);
  ctx.fillStyle = '#1e3a5f';
  roundRect(ctx, x + 8, y + 5, 42, 20, 3, true, false);
  ctx.fillStyle = '#dbeafe';
  ctx.font = 'bold 11px "Malgun Gothic", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('사훈', x + 29, y + 19);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `bold ${compact ? 11 : 12}px "Malgun Gothic", "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('거짓·추측 금지 — 확인된 코드·문서·실행 결과만 사실로 보고한다.', x + 58, y + 19);
  ctx.restore();
}

function drawFurniture(ctx, spec) {
  const l = spec.zones.LOUNGE;
  const o = spec.zones.OFFICE;
  const agents = Array.from(renderAgentsMap.values());

  // 휴게실: 좌측 커피 스테이션 + 에이전트 수만큼 개인 사물함 + 중앙 휴게 카펫 (사물함 하단과 20px 이상 간격 확보)
  drawCoffeeMachine(ctx, l.x + 16, l.y + 39);
  drawLoungeLockers(ctx, l, agents);

  ctx.fillStyle = 'rgba(26, 36, 51, 0.55)';
  ctx.strokeStyle = '#263449';
  ctx.lineWidth = 1;
  roundRect(ctx, l.x + 24, l.y + 102, l.w - 48, l.h - 116, 6, true, true);

  // 사무실: 하단 사훈 배너 + 중앙 정렬 팀원 작업 데스크 (마스터는 듀얼 모니터)
  drawMottoPlaque(ctx, o.x + 16, o.y + o.h - 40, o.w - 32, spec.mode === 'tall');

  for (const agent of agents) {
    drawDeskWithMonitor(ctx, agent.desk.x, agent.desk.y - 30, agent.shirtColor);
  }
}

function drawAgent(ctx, a) {
  const meta = STATE_META[a.state] || STATE_META.IDLE;
  const isSelected = props.canvasState.selectedAgentId === a.id;
  const isHovered = props.canvasState.hoveredAgentId === a.id;

  const bobY = a.isMoving
    ? Math.abs(Math.sin(a.animPhase * 1.4)) * -3.5
    : (a.state === 'WORKING' ? Math.sin(a.animPhase * 2) * 1.2 : 0);

  const px = Math.round(a.x);
  const py = Math.round(a.y);

  if (isSelected || isHovered) {
    ctx.save();
    ctx.strokeStyle = isSelected ? '#60a5fa' : '#94a3b8';
    ctx.lineWidth = isSelected ? 2 : 1.2;
    ctx.setLineDash(isSelected ? [] : [4, 3]);
    ctx.beginPath();
    ctx.ellipse(px, py + 14, 22, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.ellipse(px, py + 13, 13, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  const bodyY = py + bobY;

  ctx.fillStyle = '#1e293b';
  const legSwing = a.isMoving ? Math.sin(a.animPhase * 1.6) * 3 : 0;
  ctx.fillRect(px - 6, bodyY + 4 + legSwing, 5, 8);
  ctx.fillRect(px + 1, bodyY + 4 - legSwing, 5, 8);

  ctx.fillStyle = a.shirtColor;
  roundRect(ctx, px - 10, bodyY - 12, 20, 17, 4, true, false);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(px - 8, bodyY - 10, 16, 3);

  ctx.fillStyle = '#e2c7b0';
  roundRect(ctx, px - 8, bodyY - 26, 16, 15, 5, true, false);

  ctx.fillStyle = a.id === 'Master' ? '#1e1b4b' : '#1e293b';
  roundRect(ctx, px - 9, bodyY - 29, 18, 7, 3, true, false);

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(px - 4, bodyY - 20, 2, 3);
  ctx.fillRect(px + 2, bodyY - 20, 2, 3);

  ctx.font = 'bold 12.5px "Malgun Gothic", "Segoe UI", sans-serif';
  const nameW = Math.round(ctx.measureText(a.name).width + 14);
  ctx.fillStyle = isSelected ? '#1e3a8a' : 'rgba(15, 23, 42, 0.9)';
  ctx.strokeStyle = isSelected ? '#60a5fa' : '#334155';
  ctx.lineWidth = 1;
  roundRect(ctx, Math.round(px - nameW / 2), py + 17, nameW, 20, 3, true, true);

  ctx.fillStyle = '#e2e8f0';
  ctx.textAlign = 'center';
  ctx.fillText(a.name, px, py + 31);

  ctx.fillStyle = meta.color;
  ctx.beginPath();
  ctx.arc(Math.round(px + nameW / 2 - 4), py + 17, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (a.convId) {
    const hm = getHealthMeta(a.fileSizeMB, true);
    if (hm.level !== 'ok') {
      ctx.font = 'bold 10.5px Consolas, "Malgun Gothic", sans-serif';
      const badgeText = `${hm.label} ${a.fileSizeMB}MB`;
      const bw = Math.round(ctx.measureText(badgeText).width + 10);
      ctx.fillStyle = hm.level === 'danger' ? 'rgba(136, 19, 55, 0.92)' : 'rgba(120, 53, 15, 0.92)';
      ctx.strokeStyle = hm.level === 'danger' ? '#fb7185' : '#fbbf24';
      ctx.lineWidth = 1;
      roundRect(ctx, Math.round(px - bw / 2), py + 40, bw, 16, 3, true, true);
      ctx.fillStyle = hm.level === 'danger' ? '#fecdd3' : '#fef3c7';
      ctx.textAlign = 'center';
      ctx.fillText(badgeText, px, py + 52);
    }
  }
}

/**
 * ISO 타임스탬프를 짧은 경과/상대 시간 문자열로 변환
 * @author Jangsung
 * @param {String|null} isoStr
 * @param {Boolean} withSuffix
 * @return {String}
 */
function formatCompactElapsed(isoStr, withSuffix = true) {
  if (!isoStr) return '';
  const ms = new Date(isoStr).getTime();
  if (!Number.isFinite(ms)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return withSuffix ? '방금' : `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return withSuffix ? `${diffMin}분 전` : `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return withSuffix ? `${diffHour}시간 전` : `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  return withSuffix ? `${diffDay}일 전` : `${diffDay}d`;
}

/**
 * 캐릭터 상단 배지 우측 영역([상태] [경과시간]) 생성
 * @author Jangsung
 * @param {Object} a
 * @return {String}
 */
function formatAgentBadgeRight(a) {
  if (a.cliRunning) {
    return formatCompactElapsed((a.activeStream && a.activeStream.startedAt) || a.lastActiveIso, false) || '0s';
  }

  if (a.state === 'WORKING') {
    return formatCompactElapsed(a.lastActiveIso, false) || '진행중';
  }

  if (a.state === 'DONE') {
    return formatCompactElapsed(a.lastActiveIso, true) || '완료';
  }

  if (a.state === 'BLOCKED') {
    return a.bubbleText && a.bubbleText.includes('중단') ? '중단됨' : '오류';
  }

  if (!a.convId) return '미연결';
  return formatCompactElapsed(a.lastActiveIso, true) || '연결됨';
}

function drawBubble(ctx, a, logicalW) {
  const meta = STATE_META[a.state] || STATE_META.IDLE;
  const tag = `[${meta.label}]`;
  const rightText = formatAgentBadgeRight(a);

  ctx.font = 'bold 11px Consolas, sans-serif';
  const tagW = ctx.measureText(tag).width;
  ctx.font = '11.5px "Malgun Gothic", "Segoe UI", sans-serif';
  const textW = rightText ? ctx.measureText(rightText).width : 0;

  const padX = 7;
  const gap = rightText ? 5 : 0;
  const totalW = Math.round(tagW + gap + textW + padX * 2);
  const h = 23;
  const ax = Math.round(a.x);
  const ay = Math.round(a.y);
  const bx = Math.round(Math.max(8, Math.min(logicalW - totalW - 8, ax - totalW / 2)));
  const by = ay - 60;

  ctx.fillStyle = 'rgba(13, 18, 26, 0.94)';
  ctx.strokeStyle = meta.color;
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, totalW, h, 4, true, true);

  ctx.fillStyle = meta.color;
  ctx.beginPath();
  ctx.moveTo(ax - 3.5, by + h);
  ctx.lineTo(ax + 3.5, by + h);
  ctx.lineTo(ax, by + h + 4.5);
  ctx.closePath();
  ctx.fill();

  ctx.font = 'bold 11px Consolas, sans-serif';
  ctx.fillStyle = meta.color;
  ctx.textAlign = 'left';
  ctx.fillText(tag, bx + padX, by + 15);

  if (rightText) {
    ctx.font = '11.5px "Malgun Gothic", "Segoe UI", sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(rightText, Math.round(bx + padX + tagW + gap), by + 15);
  }
}

/**
 * 마우스 호버 중인 에이전트의 작업 상세 요약 툴팁 표시
 * @author Jangsung
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} a
 * @param {Number} logicalW
 */
function drawHoverTooltip(ctx, a, logicalW) {
  const rawDetail = a.currentTask && a.currentTask !== '-' ? a.currentTask : a.bubbleText;
  if (!rawDetail || rawDetail === '-') return;
  const text = rawDetail.length > 34 ? `${rawDetail.slice(0, 34)}...` : rawDetail;

  ctx.font = '11.5px "Malgun Gothic", "Segoe UI", sans-serif';
  const textW = ctx.measureText(text).width;
  const padX = 9;
  const totalW = Math.round(textW + padX * 2);
  const h = 22;
  const ax = Math.round(a.x);
  const by = Math.max(8, Math.round(a.y) - 86);
  const bx = Math.round(Math.max(8, Math.min(logicalW - totalW - 8, ax - totalW / 2)));

  ctx.fillStyle = 'rgba(15, 23, 42, 0.98)';
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, totalW, h, 4, true, true);

  ctx.fillStyle = '#f1f5f9';
  ctx.textAlign = 'left';
  ctx.fillText(text, bx + padX, by + 15);
}

function drawPackets(ctx) {
  for (const p of renderPackets) {
    const fromA = p.fromId ? renderAgentsMap.get(p.fromId) : null;
    const toA = p.toId ? renderAgentsMap.get(p.toId) : null;
    const fx = fromA ? fromA.x : p.fromX;
    const fy = fromA ? fromA.y - 16 : p.fromY;
    const tx = toA ? toA.x : p.toX;
    const ty = toA ? toA.y - 16 : p.toY;

    ctx.save();
    ctx.strokeStyle = p.color;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();

    const t = p.progress;
    const curX = fx + (tx - fx) * t;
    const arcLift = Math.sin(t * Math.PI) * -32;
    const curY = fy + (ty - fy) * t + arcLift;

    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 1.5;
    roundRect(ctx, curX - 24, curY - 10, 48, 20, 3, true, true);

    ctx.fillStyle = p.color;
    ctx.font = 'bold 10.5px Consolas, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.label, curX, curY + 4);
  }
}

/**
 * 현재 캔버스 전체 장면 렌더링 (애니메이션 루프 및 리사이즈 즉시 반영 공용)
 * @author Jangsung
 * @param {CanvasRenderingContext2D} ctx
 */
function renderScene(ctx) {
  ctx.setTransform(renderScaleX, 0, 0, renderScaleY, 0, 0);
  ctx.clearRect(0, 0, currentSpec.width, currentSpec.height);
  drawFloorGrid(ctx, currentSpec.width, currentSpec.height);
  drawZones(ctx, currentSpec.zones);
  drawFurniture(ctx, currentSpec);

  const sortedAgents = Array.from(renderAgentsMap.values()).sort((a, b) => a.y - b.y);
  for (const agent of sortedAgents) {
    drawAgent(ctx, agent);
  }
  drawPackets(ctx);
  for (const agent of sortedAgents) {
    drawBubble(ctx, agent, currentSpec.width);
  }
  if (props.canvasState.hoveredAgentId) {
    const hovered = renderAgentsMap.get(props.canvasState.hoveredAgentId);
    if (hovered) drawHoverTooltip(ctx, hovered, currentSpec.width);
  }
}

/**
 * 60fps 물리 보간 및 캔버스 렌더링 루프
 * @author Jangsung
 * @param {Number} nowMs
 */
function animationLoop(nowMs) {
  const dtSec = lastFrameMs ? Math.min(0.05, (nowMs - lastFrameMs) / 1000) : 0.016;
  lastFrameMs = nowMs;
  tickCount += 1;

  const speed = 155;
  for (const a of renderAgentsMap.values()) {
    a.animPhase += dtSec * 6;
    const dx = a.targetX - a.x;
    const dy = a.targetY - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1.5) {
      const step = Math.min(dist, speed * dtSec);
      a.x += (dx / dist) * step;
      a.y += (dy / dist) * step;
      a.isMoving = true;
    } else {
      a.x = a.targetX;
      a.y = a.targetY;
      a.isMoving = false;
    }
  }

  const expiredIds = [];
  for (let i = renderPackets.length - 1; i >= 0; i--) {
    const p = renderPackets[i];
    p.progress += dtSec * 1.45;
    if (p.progress >= 1) {
      expiredIds.push(p.id);
      renderPackets.splice(i, 1);
    }
  }
  if (expiredIds.length > 0) {
    emitAction('CONSUME_PACKETS', { expiredIds });
  }

  const canvas = canvasRef.value;
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (ctx) {
    renderScene(ctx);
  }

  rafId = requestAnimationFrame(animationLoop);
}

onMounted(() => {
  resizeCanvas();
  if (typeof ResizeObserver !== 'undefined' && frameRef.value) {
    resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(frameRef.value);
  }
  window.addEventListener('resize', resizeCanvas);
  rafId = requestAnimationFrame(animationLoop);
});

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId);
  if (resizeObserver) resizeObserver.disconnect();
  window.removeEventListener('resize', resizeCanvas);
});
</script>

<style lang="scss" scoped>
.stage-container {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background-color: $bg-base;
  overflow: hidden;
}

.canvas-frame {
  flex: 1;
  min-height: 0;
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #11161f;
  border: 1px solid $border-subtle;
  border-radius: 6px;
  overflow: hidden;
}

.office-canvas {
  display: block;
}

.stage-footer {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  background-color: $bg-surface;
  border: 1px solid $border-subtle;
  border-radius: 4px;
}

.stage-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: $text-secondary;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;

  &.dot-idle { background-color: $state-idle; }
  &.dot-working { background-color: $state-working; }
  &.dot-blocked { background-color: $state-blocked; }
  &.dot-done { background-color: $state-done; }
}

.stage-hint {
  font-size: 11px;
  color: $text-muted;
}
</style>
