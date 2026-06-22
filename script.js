const canvas = document.querySelector('#cat');
const context = canvas.getContext('2d', { alpha: false });
const catSound = document.querySelector('#cat-sound');
const audioStartButton = document.querySelector('#audio-start');
const isTouchDevice = matchMedia('(pointer: coarse)').matches
  || navigator.maxTouchPoints > 0
  || 'ontouchstart' in window;

if (isTouchDevice) {
  document.documentElement.classList.add('touch-device');
}

// 첫 프레임 측정값: 전체 436×322px, 실제 고양이 높이는 약 69%.
const CAT_VISIBLE_HEIGHT_RATIO = 0.69;
const MIN_SIZE_DIVISOR = 6;
const MAX_SIZE_DIVISOR = 2;
const DISTANCE_CYCLES = 4;

const BASE_PLAYBACK_RATE = 0.65;
const MAX_PLAYBACK_RATE = 5;
const BASE_AUDIO_RATE = 1.5;
const MAX_AUDIO_RATE = 2;
const ACCELERATION_DEAD_ZONE = 1.1;
const ACCELERATION_FULL_SCALE = 50;
const INPUT_ACCELERATION_GAIN = {
  mouse: 1.15,
  touch: 0.85,
  pen: 1,
};
const FRAME_COUNT = 30;
const FRAME_DURATION_MS = 100;
const FRAME_WIDTH = 436;
const FRAME_HEIGHT = 322;
const LEFT_EDGE_MASK_PX = 4;
const GIF_BACKGROUND_COLOR = '#fdfdfd';

let frames = [];
let totalAnimationDuration = 0;
let animationClock = 0;

let pointerX = innerWidth / 2;
let pointerY = innerHeight / 2;
let previousPointerX = pointerX;
let previousPointerY = pointerY;
let previousVelocityX = 0;
let previousVelocityY = 0;
let previousPointerTime = performance.now();
let activeTouchPointerId = null;

let currentVisibleSize = Math.min(innerWidth, innerHeight) / MIN_SIZE_DIVISOR;
let playbackExcitement = 0;
let currentPlaybackRate = BASE_PLAYBACK_RATE;
let currentAudioRate = BASE_AUDIO_RATE;
let rightMotionIntensity = 0;
let previousRenderTime = performance.now();
let soundUnlocked = false;
let soundStarting = false;

async function startSound() {
  if (!catSound.paused) {
    soundUnlocked = true;
    audioStartButton.classList.add('is-hidden');
    return true;
  }
  if (soundStarting) return false;

  soundStarting = true;
  catSound.volume = 0.65;
  catSound.muted = false;
  catSound.defaultMuted = false;
  catSound.playbackRate = BASE_AUDIO_RATE;
  try {
    await catSound.play();
    soundUnlocked = true;
    audioStartButton.classList.add('is-hidden');
    return true;
  } catch {
    soundUnlocked = false;
    audioStartButton.classList.remove('is-hidden');
    return false;
  } finally {
    soundStarting = false;
  }
}

async function loadGifFrames() {
  const images = await Promise.all(
    Array.from({ length: FRAME_COUNT }, (_, index) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = `assets/frames/frame-${String(index).padStart(2, '0')}.png`;
    })),
  );

  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (const image of images) {
    frames.push({
      image,
      duration: FRAME_DURATION_MS,
      startsAt: totalAnimationDuration,
    });
    totalAnimationDuration += FRAME_DURATION_MS;
  }
}

function distanceRatioToEdge(x, y) {
  const centerX = innerWidth / 2;
  const centerY = innerHeight / 2;
  const dx = x - centerX;
  const dy = y - centerY;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return 0;

  const scaleX = dx > 0
    ? (innerWidth - centerX) / dx
    : dx < 0
      ? -centerX / dx
      : Infinity;
  const scaleY = dy > 0
    ? (innerHeight - centerY) / dy
    : dy < 0
      ? -centerY / dy
      : Infinity;

  return Math.min(1, 1 / Math.min(scaleX, scaleY));
}

function targetVisibleSize() {
  const shortSide = Math.min(innerWidth, innerHeight);
  const isMobilePointer = matchMedia('(pointer: coarse)').matches;
  const desktopMinSize = Math.max(shortSide / MIN_SIZE_DIVISOR, 64);
  const previousMaxSize = Math.max(shortSide / MAX_SIZE_DIVISOR, 160);
  const minSize = isMobilePointer ? previousMaxSize : desktopMinSize;
  const maxSize = isMobilePointer ? previousMaxSize * 1.75 : previousMaxSize;
  const ratio = distanceRatioToEdge(pointerX, pointerY);
  const wave = (1 - Math.cos(ratio * Math.PI * 2 * DISTANCE_CYCLES)) / 2;
  return minSize + wave * (maxSize - minSize);
}

function handlePointerMove(event) {
  if (event.pointerType === 'touch' && event.pointerId !== activeTouchPointerId) return;

  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.008, (now - previousPointerTime) / 1000));
  const x = event.clientX;
  const y = event.clientY;
  const movement = Math.hypot(x - previousPointerX, y - previousPointerY);

  const velocityX = (x - previousPointerX) / dt;
  const velocityY = (y - previousPointerY) / dt;
  const accelerationX = (velocityX - previousVelocityX) / dt;
  const accelerationY = (velocityY - previousVelocityY) / dt;
  const shortSide = Math.max(1, Math.min(innerWidth, innerHeight));
  const acceleration = Math.hypot(accelerationX, accelerationY) / shortSide;
  const normalizedAcceleration = Math.max(
    0,
    Math.min(
      1,
      (acceleration - ACCELERATION_DEAD_ZONE)
        / (ACCELERATION_FULL_SCALE - ACCELERATION_DEAD_ZONE),
    ),
  );

  // 모바일에서는 누른 채로 분명하게 흔들 때만 프레임을 가속한다.
  // 터치 위치 자체는 이동량과 무관하게 계속 크기 변화에 사용된다.
  const minimumIntentionalMovement = event.pointerType === 'touch' ? 3 : 2;
  const isIntentionalMotion = movement >= minimumIntentionalMovement;
  const inputGain = INPUT_ACCELERATION_GAIN[event.pointerType] ?? 1;
  const normalized = isIntentionalMotion
    ? Math.min(1, normalizedAcceleration * inputGain)
    : 0;

  // 추가 효과음 없이 오른쪽 이동에만 메인 음원의 배속을 연결한다.
  const horizontalSpeed = Math.abs(velocityX) / shortSide;
  const rightIntensity = isIntentionalMotion && velocityX > 0
    ? Math.min(1, Math.max(0, (horizontalSpeed - 0.25) / 3.5) * inputGain)
    : 0;
  if (velocityX > 0) {
    rightMotionIntensity = Math.max(rightMotionIntensity, rightIntensity);
  } else if (velocityX < 0) {
    rightMotionIntensity *= 0.35;
  }

  // 가속도 입력을 완충해 짧은 손떨림에 배속이 튀지 않게 한다.
  playbackExcitement += (normalized - playbackExcitement) * 0.32;
  pointerX = x;
  pointerY = y;
  previousPointerX = x;
  previousPointerY = y;
  previousVelocityX = velocityX;
  previousVelocityY = velocityY;
  previousPointerTime = now;
}

function handlePointerDown(event) {
  if (event.pointerType !== 'touch') {
    startSound();
  }

  if (event.pointerType === 'touch') {
    if (activeTouchPointerId !== null) return;
    activeTouchPointerId = event.pointerId;
  }

  previousPointerX = event.clientX;
  previousPointerY = event.clientY;
  previousVelocityX = 0;
  previousVelocityY = 0;
  previousPointerTime = performance.now();
  pointerX = event.clientX;
  pointerY = event.clientY;
}

function handlePointerEnd(event) {
  if (event.pointerType !== 'touch' || event.pointerId !== activeTouchPointerId) return;

  activeTouchPointerId = null;
  pointerX = innerWidth / 2;
  pointerY = innerHeight / 2;
  previousPointerX = pointerX;
  previousPointerY = pointerY;
  previousVelocityX = 0;
  previousVelocityY = 0;
  previousPointerTime = performance.now();
}

function frameAt(clock) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (clock >= frames[index].startsAt) return frames[index].image;
  }
  return frames[0].image;
}

function render(now) {
  const dt = Math.min(0.05, (now - previousRenderTime) / 1000);
  previousRenderTime = now;

  const desiredSize = targetVisibleSize();
  currentVisibleSize += (desiredSize - currentVisibleSize) * (1 - Math.exp(-11 * dt));

  playbackExcitement *= Math.exp(-0.95 * dt);
  const desiredPlaybackRate = BASE_PLAYBACK_RATE
    + playbackExcitement * (MAX_PLAYBACK_RATE - BASE_PLAYBACK_RATE);
  const rateEase = 1 - Math.exp(-(desiredPlaybackRate > currentPlaybackRate ? 8 : 2.4) * dt);
  currentPlaybackRate += (desiredPlaybackRate - currentPlaybackRate) * rateEase;

  rightMotionIntensity *= Math.exp(-3.6 * dt);
  const desiredAudioRate = BASE_AUDIO_RATE
    + rightMotionIntensity * (MAX_AUDIO_RATE - BASE_AUDIO_RATE);
  const audioRateEase = 1 - Math.exp(-(desiredAudioRate > currentAudioRate ? 7 : 3) * dt);
  currentAudioRate += (desiredAudioRate - currentAudioRate) * audioRateEase;
  catSound.playbackRate = Math.max(BASE_AUDIO_RATE, Math.min(MAX_AUDIO_RATE, currentAudioRate));

  animationClock = (animationClock + dt * 1000 * currentPlaybackRate) % totalAnimationDuration;

  const cssHeight = currentVisibleSize / CAT_VISIBLE_HEIGHT_RATIO;
  const cssWidth = cssHeight * (canvas.width / canvas.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  context.fillStyle = GIF_BACKGROUND_COLOR;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(frameAt(animationClock), 0, 0);

  // 원본 GIF 왼쪽의 검은 세로줄을 Canvas 안에서 덮는다.
  // 이 마스크는 Canvas와 함께 확대·축소되므로 따로 어긋나지 않는다.
  context.fillStyle = GIF_BACKGROUND_COLOR;
  context.fillRect(0, 0, LEFT_EDGE_MASK_PX, canvas.height);

  requestAnimationFrame(render);
}

addEventListener('pointermove', handlePointerMove, { passive: true });
addEventListener('pointerdown', handlePointerDown, { passive: true });
addEventListener('pointerup', handlePointerEnd, { passive: true });
addEventListener('pointercancel', handlePointerEnd, { passive: true });

// 모바일은 실제 버튼 click 한 번만 사용한다. touchstart에서 먼저 호출하면
// 카카오톡이 인정하는 click이 soundStarting 잠금에 막힐 수 있다.
audioStartButton.addEventListener('click', startSound);

// PC의 기존 첫 클릭 재생 경로는 유지한다.
document.addEventListener('click', () => {
  if (!isTouchDevice) startSound();
}, { capture: true, passive: true });

// PC에서는 버튼 없이 즉시 재생을 시도한다. 자동재생이 차단되면 첫 클릭에서 재시도된다.
if (!isTouchDevice) {
  startSound();
}

function handleViewportChange() {
  pointerX = Math.min(pointerX, innerWidth);
  pointerY = Math.min(pointerY, innerHeight);
  if (activeTouchPointerId === null && matchMedia('(pointer: coarse)').matches) {
    pointerX = innerWidth / 2;
    pointerY = innerHeight / 2;
  }
}

addEventListener('resize', handleViewportChange);
addEventListener('orientationchange', handleViewportChange);
document.addEventListener('visibilitychange', () => {
  previousRenderTime = performance.now();
  previousPointerTime = previousRenderTime;
  previousVelocityX = 0;
  previousVelocityY = 0;

  if (document.hidden) {
    catSound.pause();
  } else if (soundUnlocked) {
    catSound.play().catch(() => {});
  }
});
loadGifFrames()
  .then(() => requestAnimationFrame(render))
  .catch((error) => console.error(error));
