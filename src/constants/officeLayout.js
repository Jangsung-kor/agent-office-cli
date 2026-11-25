export const LOGICAL_WIDTH = 1040;
export const LOGICAL_HEIGHT = 660;

export const STATE_META = {
  IDLE: { label: 'IDLE', ko: '대기 중', color: '#64748b', bg: 'rgba(100,116,139,0.16)' },
  PLANNING: { label: 'PLANNING', ko: '분석/배분', color: '#818cf8', bg: 'rgba(129,140,248,0.16)' },
  WORKING: { label: 'WORKING', ko: '작업 수행', color: '#3b82f6', bg: 'rgba(59,130,246,0.16)' },
  REVIEW: { label: 'REVIEW', ko: '검증/검수', color: '#2dd4bf', bg: 'rgba(45,212,191,0.16)' },
  BLOCKED: { label: 'BLOCKED', ko: '일시중단', color: '#d97706', bg: 'rgba(217,119,6,0.16)' },
  DONE: { label: 'DONE', ko: '완료 보고', color: '#10b981', bg: 'rgba(16,185,129,0.16)' }
};

const SHIRT_PALETTE = [
  '#4f46e5',
  '#2563eb',
  '#0284c7',
  '#0d9488',
  '#d97706',
  '#475569',
  '#3b6e8c',
  '#6d5a82'
];

const LOUNGE_CHIPS = [
  { label: 'IDLE', color: '#64748b' },
  { label: 'DONE', color: '#10b981' }
];

const OFFICE_CHIPS = [
  { label: 'PLANNING', color: '#818cf8' },
  { label: 'WORKING', color: '#3b82f6' },
  { label: 'REVIEW', color: '#2dd4bf' },
  { label: 'BLOCKED', color: '#d97706' }
];

export const ZONES = {
  LOUNGE: {
    id: 'LOUNGE',
    name: '휴게실 (LOUNGE)',
    x: 28,
    y: 20,
    w: 984,
    h: 236,
    fill: '#121720',
    border: '#253042',
    statusChips: LOUNGE_CHIPS
  },
  OFFICE: {
    id: 'OFFICE',
    name: '사무실 (OFFICE)',
    x: 28,
    y: 270,
    w: 984,
    h: 370,
    fill: '#131922',
    border: '#263040',
    statusChips: OFFICE_CHIPS
  }
};

// 동적 워커 슬롯 기본 fallback (assignAgentSeats에서 현재 모드 기준으로 재계산됨)
const EXTRA_WORKER_SLOTS = SHIRT_PALETTE.slice(4).map((shirtColor, idx) => ({
  desk: { x: 400 + idx * 60, y: 460 },
  lounge: { x: 240 + idx * 80, y: 170 },
  meetingSeat: { x: 460 + idx * 40, y: 440 },
  shirtColor
}));

/**
 * 2구역(LOUNGE + OFFICE) 중앙 집중형 동적 좌석 계산기 생성 (가로/세로 공용)
 * @author Jangsung
 * @param {Object} lounge
 * @param {Object} office
 * @param {Object} opts
 * @return {Function}
 */
function createCenteredSeatResolver(lounge, office, { maxDeskCols, deskPitchX, maxRowPitchY, maxLoungeCols, loungePitchX }) {
  const officeCenterX = office.x + office.w / 2;
  const loungeCenterX = lounge.x + lounge.w / 2;

  return (idx, totalCount = 3) => {
    const safeTotal = Math.max(1, totalCount);

    // 1. 사무실: 중앙 정렬 그리드 배치 (행마다 실제 인원 기준으로 중앙 균등 정렬)
    const deskCols = safeTotal <= maxDeskCols
      ? safeTotal
      : Math.min(maxDeskCols, Math.ceil(safeTotal / Math.ceil(safeTotal / maxDeskCols)));
    const deskRows = Math.ceil(safeTotal / deskCols);
    const dRow = Math.floor(idx / deskCols);
    const dCol = idx % deskCols;
    const dRowItems = Math.min(deskCols, safeTotal - dRow * deskCols);
    const deskX = Math.round(officeCenterX - ((dRowItems - 1) * deskPitchX) / 2 + dCol * deskPitchX);

    const usableTop = office.y + 92;
    const usableBot = office.y + office.h - 76;
    const dStepY = deskRows > 1
      ? Math.min(maxRowPitchY, Math.floor(Math.max(96, usableBot - usableTop) / (deskRows - 1)))
      : 0;
    const deskStartY = Math.round((usableTop + usableBot) / 2 - ((deskRows - 1) * dStepY) / 2);
    const deskY = deskStartY + dRow * dStepY;

    // 2. 휴게실: 상단 개인 사물함 하단에 중앙 정렬 배치
    const loungeCols = Math.min(maxLoungeCols, safeTotal);
    const loungeRows = Math.ceil(safeTotal / loungeCols);
    const lRow = Math.floor(idx / loungeCols);
    const lCol = idx % loungeCols;
    const lRowItems = Math.min(loungeCols, safeTotal - lRow * loungeCols);
    const effLoungePitch = lRowItems > 1
      ? Math.min(loungePitchX, Math.floor((lounge.w - 120) / (lRowItems - 1)))
      : 0;
    const loungeX = Math.round(loungeCenterX - ((lRowItems - 1) * effLoungePitch) / 2 + lCol * effLoungePitch);
    const lUsableTop = lounge.y + 154;
    const lUsableBot = lounge.y + lounge.h - 44;
    const lStepY = loungeRows > 1
      ? Math.min(64, Math.floor(Math.max(48, lUsableBot - lUsableTop) / (loungeRows - 1)))
      : 0;
    const lStartY = loungeRows === 1
      ? Math.round(lounge.y + lounge.h * 0.67)
      : Math.round((lUsableTop + lUsableBot) / 2 - ((loungeRows - 1) * lStepY) / 2);
    const loungeY = lStartY + lRow * lStepY;

    // 3. 회의 소집 시 사무실 중앙 원형/군집 배치
    const mCols = Math.min(4, safeTotal);
    const mRows = Math.ceil(safeTotal / mCols);
    const mRow = Math.floor(idx / mCols);
    const mCol = idx % mCols;
    const mRowItems = Math.min(mCols, safeTotal - mRow * mCols);
    const meetingX = Math.round(officeCenterX - ((mRowItems - 1) * 92) / 2 + mCol * 92);
    const meetingY = Math.round(office.y + office.h * 0.52 - ((mRows - 1) * 72) / 2 + mRow * 72);

    return {
      desk: { x: deskX, y: deskY },
      lounge: { x: loungeX, y: loungeY },
      meetingSeat: { x: meetingX, y: meetingY },
      shirtColor: SHIRT_PALETTE[idx % SHIRT_PALETTE.length]
    };
  };
}

/**
 * 패널 가용 크기(availW, availH)에 맞춰 가로형(wide) 또는 세로형(tall) 2구역 오피스 레이아웃 사양 생성
 * @author Jangsung
 * @param {Number} availW
 * @param {Number} availH
 * @return {Object}
 */
export function buildResponsiveOfficeSpec(availW, availH) {
  const ratio = availH > 0 ? availW / availH : 1.5;
  if (ratio >= 1.05) {
    return {
      mode: 'wide',
      width: LOGICAL_WIDTH,
      height: LOGICAL_HEIGHT,
      zones: ZONES,
      getSeat: createCenteredSeatResolver(ZONES.LOUNGE, ZONES.OFFICE, {
        maxDeskCols: 4,
        deskPitchX: 158,
        maxRowPitchY: 138,
        maxLoungeCols: 6,
        loungePitchX: 146
      })
    };
  }

  // 세로형(tall) 모드: 관리자 사무실 제거 후 휴게실 + 사무실 2단 배치
  const width = 580;
  const height = Math.max(740, Math.min(1160, Math.round(width * (availH / Math.max(1, availW)))));
  const padX = 16;
  const innerW = width - padX * 2;
  const gapY = 12;

  const loungeH = Math.max(236, Math.round(height * 0.30));
  const loungeY = 14;
  const officeY = loungeY + loungeH + gapY;
  const officeH = Math.max(360, height - officeY - 14);

  const zones = {
    LOUNGE: {
      id: 'LOUNGE',
      name: '휴게실 (LOUNGE)',
      x: padX,
      y: loungeY,
      w: innerW,
      h: loungeH,
      fill: '#121720',
      border: '#253042',
      statusChips: LOUNGE_CHIPS
    },
    OFFICE: {
      id: 'OFFICE',
      name: '사무실 (OFFICE)',
      x: padX,
      y: officeY,
      w: innerW,
      h: officeH,
      fill: '#131922',
      border: '#263040',
      statusChips: OFFICE_CHIPS
    }
  };

  return {
    mode: 'tall',
    width,
    height,
    zones,
    getSeat: createCenteredSeatResolver(zones.LOUNGE, zones.OFFICE, {
      maxDeskCols: 2,
      deskPitchX: 176,
      maxRowPitchY: 142,
      maxLoungeCols: 4,
      loungePitchX: 126
    })
  };
}

/**
 * 휴게실 이동 대상 상태(IDLE, DONE) 판별
 * @author Jangsung
 * @param {String} state
 * @return {Boolean}
 */
export function isLoungeState(state) {
  return state === 'IDLE' || state === 'DONE';
}

/**
 * 활성 에이전트 목록/맵을 받아 레이아웃 사양 기준 좌표 및 색상 배정
 * @author Jangsung
 * @param {Object|Array} agentSource
 * @param {Boolean} meetingActive
 * @param {Object} layoutSpec
 * @return {Array<Object>}
 */
export function assignAgentSeats(agentSource, meetingActive = false, layoutSpec = null) {
  const entries = Array.isArray(agentSource) ? agentSource : Object.values(agentSource || {});
  if (entries.length === 0) return [];
  const spec = layoutSpec || buildResponsiveOfficeSpec(LOGICAL_WIDTH, LOGICAL_HEIGHT);

  return entries.map((agent, workIndex) => {
    const slot = spec.getSeat(workIndex, entries.length);
    const state = meetingActive ? 'PLANNING' : (agent.state || 'IDLE');
    const targetPos = meetingActive
      ? slot.meetingSeat
      : (isLoungeState(state) ? slot.lounge : slot.desk);

    return {
      ...agent,
      name: agent.name || agent.id,
      role: agent.role || '실무 에이전트',
      shirtColor: slot.shirtColor,
      desk: slot.desk,
      lounge: slot.lounge,
      meetingSeat: slot.meetingSeat,
      state,
      bubbleText: meetingActive ? '전체 동기화 회의 참석 중' : (agent.bubbleText || '대기 중'),
      currentTask: agent.currentTask || '-',
      currentTaskSummary: agent.currentTaskSummary || '-',
      currentTaskRaw: agent.currentTaskRaw || '-',
      currentTool: agent.currentTool || '-',
      logs: Array.isArray(agent.logs) ? agent.logs : [],
      targetX: targetPos.x,
      targetY: targetPos.y,
      isDynamicWorker: Boolean(agent.isDynamicWorker)
    };
  });
}

/**
 * 세션 파일 크기(MB) 기반 3단계 건강도 메타 반환
 * @author Jangsung
 * @param {Number} fileSizeMB
 * @param {Boolean} hasSession
 * @return {Object}
 */
export function getHealthMeta(fileSizeMB, hasSession) {
  if (!hasSession) {
    return { level: 'none', label: '미연결', cls: 'health-none' };
  }
  const mb = Number(fileSizeMB || 0);
  if (mb >= 10) {
    return { level: 'danger', label: '위험', cls: 'health-danger' };
  }
  if (mb >= 5) {
    return { level: 'warn', label: '주의', cls: 'health-warn' };
  }
  return { level: 'ok', label: '양호', cls: 'health-ok' };
}

/**
 * 팀 로스터에 매핑되지 않은 활성 CLI 세션을 오피스 보조 워커 슬롯으로 변환
 * @author Jangsung
 * @param {Array<Object>} sessions
 * @param {Set<String>} assignedConvIds
 * @return {Array<Object>}
 */
export function resolveDynamicWorkers(sessions, assignedConvIds) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];
  const unassignedActive = sessions.filter(
    s => !s.role && !assignedConvIds.has(s.convId) && (s.state === 'WORKING' || s.state === 'PLANNING' || s.ageSec <= 600)
  );
  return unassignedActive.slice(0, EXTRA_WORKER_SLOTS.length).map((s, idx) => {
    const slot = EXTRA_WORKER_SLOTS[idx];
    return {
      id: `CLI_${s.convId.slice(0, 6)}`,
      name: `CLI-${s.convId.slice(0, 4)}`,
      role: 'CLI 세션 워커',
      domainPath: '~/.gemini/antigravity-cli',
      shirtColor: slot.shirtColor,
      desk: slot.desk,
      lounge: slot.lounge,
      meetingSeat: slot.meetingSeat,
      isDynamicWorker: true,
      convId: s.convId,
      convOrigin: 'cli',
      state: s.state || 'IDLE',
      bubbleText: s.titlePreview || 'CLI 세션',
      currentTask: s.titlePreview || '-',
      currentTaskSummary: s.titlePreview || '-',
      currentTaskRaw: s.titlePreview || '-',
      currentTool: s.currentTool || '-',
      fileSizeMB: s.fileSizeMB || 0,
      lastStepIndex: s.lastStepIndex || 0,
      lastActiveIso: s.lastActiveIso || null,
      cliRunning: s.state === 'WORKING' || s.state === 'PLANNING',
      logs: []
    };
  });
}
