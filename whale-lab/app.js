const audioInput = document.querySelector("#audioInput");
const dropZone = document.querySelector("#dropZone");
const emptyState = document.querySelector("#emptyState");
const results = document.querySelector("#results");
const trackName = document.querySelector("#trackName");
const trackMeta = document.querySelector("#trackMeta");
const playButton = document.querySelector("#playButton");
const playIcon = document.querySelector("#playIcon");
const playLabel = document.querySelector("#playLabel");
const waveformCanvas = document.querySelector("#waveformCanvas");
const spectrogramCanvas = document.querySelector("#spectrogramCanvas");
const playhead = document.querySelector("#playhead");
const timeReadout = document.querySelector("#timeReadout");
const eventTimeline = document.querySelector("#eventTimeline");
const speciesCandidatesElement = document.querySelector("#speciesCandidates");

const metricElements = {
  dominantFrequency: document.querySelector("#dominantFrequency"),
  spectralCentroid: document.querySelector("#spectralCentroid"),
  eventCount: document.querySelector("#eventCount"),
  pulseRate: document.querySelector("#pulseRate"),
  patternGlyph: document.querySelector("#patternGlyph"),
  patternName: document.querySelector("#patternName"),
  patternDescription: document.querySelector("#patternDescription"),
  confidenceValue: document.querySelector("#confidenceValue"),
  confidenceBar: document.querySelector("#confidenceBar"),
};

let audioContext;
let currentBuffer = null;
let currentSource = null;
let currentAnalysis = null;
let startedAt = 0;
let pausedAt = 0;
let playing = false;
let playheadFrame = 0;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function loadFile(file) {
  if (!file) return;

  try {
    setBusy(true);
    stopPlayback();
    const context = getAudioContext();
    const bytes = await file.arrayBuffer();
    const buffer = await context.decodeAudioData(bytes.slice(0));
    await presentBuffer(buffer, file.name, `${formatBytes(file.size)} · 사용자 음원`);
  } catch (error) {
    console.error(error);
    window.alert("이 음원을 해석하지 못했습니다. 브라우저가 지원하는 WAV, MP3, OGG 또는 M4A 파일인지 확인해주세요.");
  } finally {
    setBusy(false);
    audioInput.value = "";
  }
}

async function presentBuffer(buffer, name, sourceLabel) {
  currentBuffer = buffer;
  pausedAt = 0;
  trackName.textContent = name;
  trackMeta.textContent = `${formatDuration(buffer.duration)} · ${formatRate(buffer.sampleRate)} · ${sourceLabel}`;
  emptyState.classList.add("hidden");
  results.classList.remove("hidden");

  await nextFrame();
  const mono = mixToMono(buffer);
  currentAnalysis = analyzeSignal(mono, buffer.sampleRate, buffer.duration);
  drawWaveform(mono);
  drawSpectrogram(mono, buffer.sampleRate);
  showAnalysis(currentAnalysis, buffer.duration);
  updatePlaybackUi();
}

function setBusy(isBusy) {
  dropZone.style.pointerEvents = isBusy ? "none" : "";
  dropZone.querySelector("strong").textContent = isBusy ? "신호 분석 중…" : "음원 놓기";
}

function mixToMono(buffer) {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return mono;
}

function analyzeSignal(data, sampleRate, duration) {
  const fftSize = 1024;
  const frameCount = Math.min(520, Math.max(48, Math.floor(duration * 20)));
  const step = Math.max(1, Math.floor((data.length - fftSize) / Math.max(1, frameCount - 1)));
  const spectrumSum = new Float64Array(fftSize / 2);
  const energy = [];
  let zeroCrossings = 0;
  let totalSamples = 0;
  let peakToMeanSum = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = Math.min(data.length - fftSize, frameIndex * step);
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    let sumSquares = 0;
    let frameCrossings = 0;

    for (let i = 0; i < fftSize; i += 1) {
      const sample = data[Math.max(0, start + i)] || 0;
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      real[i] = sample * window;
      sumSquares += sample * sample;
      if (i > 0 && (data[start + i - 1] || 0) * sample < 0) frameCrossings += 1;
    }

    fft(real, imag);
    let framePeak = 0;
    let frameMean = 0;
    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imag[bin]);
      spectrumSum[bin] += magnitude;
      framePeak = Math.max(framePeak, magnitude);
      frameMean += magnitude;
    }

    energy.push(Math.sqrt(sumSquares / fftSize));
    zeroCrossings += frameCrossings;
    totalSamples += fftSize;
    peakToMeanSum += framePeak / Math.max(1e-9, frameMean / (fftSize / 2 - 1));
  }

  let totalMagnitude = 0;
  let weightedFrequency = 0;
  let dominantBin = 1;
  for (let bin = 1; bin < spectrumSum.length; bin += 1) {
    const frequency = (bin * sampleRate) / fftSize;
    totalMagnitude += spectrumSum[bin];
    weightedFrequency += frequency * spectrumSum[bin];
    if (spectrumSum[bin] > spectrumSum[dominantBin]) dominantBin = bin;
  }

  const dominantFrequency = (dominantBin * sampleRate) / fftSize;
  const spectralCentroid = weightedFrequency / Math.max(totalMagnitude, 1e-9);
  const tonalness = peakToMeanSum / frameCount;
  const zeroCrossingRate = zeroCrossings / Math.max(1, totalSamples);
  const events = detectEvents(energy, duration);
  const pulseRate = estimatePulseRate(events);
  const pattern = classifyPattern({
    dominantFrequency,
    spectralCentroid,
    tonalness,
    zeroCrossingRate,
    events,
    pulseRate,
    duration,
  });
  const speciesCandidates = estimateSpeciesCandidates({
    dominantFrequency,
    spectralCentroid,
    tonalness,
    zeroCrossingRate,
    events,
    pulseRate,
    duration,
    pattern,
  });

  return {
    dominantFrequency,
    spectralCentroid,
    events,
    pulseRate,
    tonalness,
    zeroCrossingRate,
    pattern,
    speciesCandidates,
  };
}

function detectEvents(energy, duration) {
  const sorted = [...energy].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const upper = sorted[Math.floor(sorted.length * 0.82)] || 0;
  const threshold = Math.max(median * 1.7, upper * 0.62, 0.002);
  const events = [];
  let active = false;
  let peakIndex = 0;
  let peakEnergy = 0;

  energy.forEach((value, index) => {
    if (value >= threshold) {
      if (!active) {
        active = true;
        peakIndex = index;
        peakEnergy = value;
      } else if (value > peakEnergy) {
        peakIndex = index;
        peakEnergy = value;
      }
    } else if (active) {
      events.push((peakIndex / Math.max(1, energy.length - 1)) * duration);
      active = false;
      peakEnergy = 0;
    }
  });

  if (active) {
    events.push((peakIndex / Math.max(1, energy.length - 1)) * duration);
  }

  return events.filter((time, index) => index === 0 || time - events[index - 1] > 0.035);
}

function estimatePulseRate(events) {
  if (events.length < 3) return 0;
  const intervals = [];
  for (let i = 1; i < events.length; i += 1) {
    const interval = events[i] - events[i - 1];
    if (interval > 0.035 && interval < 3) intervals.push(interval);
  }
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a - b);
  return 1 / intervals[Math.floor(intervals.length / 2)];
}

function classifyPattern(features) {
  const { spectralCentroid, dominantFrequency, tonalness, zeroCrossingRate, events, pulseRate, duration } = features;
  const eventDensity = events.length / Math.max(1, duration);

  if (pulseRate > 1.5 && (spectralCentroid > 900 || zeroCrossingRate > 0.12)) {
    const confidence = clamp(58 + pulseRate * 5 + eventDensity * 4, 58, 92);
    return {
      name: "펄스 클릭 열",
      glyph: "•••",
      confidence,
      description: "짧고 반복적인 광대역 펄스가 우세합니다. 반향정위 클릭이나 코다형 리듬과 닮은 음향 구조입니다.",
    };
  }

  if (tonalness > 7 && (spectralCentroid > 1100 || dominantFrequency > 900)) {
    const confidence = clamp(54 + tonalness * 2.1, 55, 90);
    return {
      name: "협대역 휘파람",
      glyph: "∿",
      confidence,
      description: "뚜렷한 기본 주파수와 비교적 좁은 대역이 관찰됩니다. 휘파람 또는 변조 호출음과 유사합니다.",
    };
  }

  if (tonalness > 4 || spectralCentroid < 1000) {
    const confidence = clamp(52 + tonalness * 2.4 + (spectralCentroid < 700 ? 8 : 0), 52, 88);
    return {
      name: "지속 변조음",
      glyph: "〰",
      confidence,
      description: "저·중주파의 이어지는 음과 배음 구조가 우세합니다. 노래, 신음 또는 지속 호출음과 닮았습니다.",
    };
  }

  return {
    name: "혼합 또는 미확인 신호",
    glyph: "⌁",
    confidence: 46,
    description: "여러 음향 형태가 섞였거나 신호 대 잡음비가 낮습니다. 더 깨끗한 원본과 녹음 정보를 함께 확인하세요.",
  };
}

function estimateSpeciesCandidates(features) {
  const { dominantFrequency, spectralCentroid, tonalness, pulseRate, pattern } = features;
  const isClickTrain = pattern.name === "펄스 클릭 열";
  const isWhistle = pattern.name === "협대역 휘파람";
  const isSustained = pattern.name === "지속 변조음";
  const pulseFit = pulseRate ? clamp(pulseRate / 4, 0, 1) : 0;
  const tonalFit = clamp((tonalness - 2) / 12, 0, 1);

  const profiles = [
    {
      name: "향유고래",
      scientific: "Physeter macrocephalus",
      score:
        14 +
        Number(isClickTrain) * 38 +
        bandFit(spectralCentroid, 1000, 14000) * 22 +
        pulseFit * 13,
      reason: "반복적인 광대역 클릭과 높은 스펙트럼 중심",
    },
    {
      name: "혹등고래",
      scientific: "Megaptera novaeangliae",
      score:
        15 +
        Number(isSustained) * 32 +
        bandFit(dominantFrequency, 80, 4000) * 24 +
        tonalFit * 12,
      reason: "이어지는 변조음과 저·중주파 배음 구조",
    },
    {
      name: "대왕고래",
      scientific: "Balaenoptera musculus",
      score:
        7 +
        Number(isSustained) * 19 +
        bandFit(dominantFrequency, 10, 120) * 44 +
        (dominantFrequency < 80 ? 10 : 0),
      reason: "매우 낮은 주파수의 길고 강한 발성",
    },
    {
      name: "긴수염고래",
      scientific: "Balaenoptera physalus",
      score:
        8 +
        bandFit(dominantFrequency, 15, 180) * 36 +
        (pulseRate >= 0.3 && pulseRate <= 2.5 ? 18 : 0) +
        Number(isSustained) * 9,
      reason: "저주파 펄스와 비교적 일정한 반복 간격",
    },
    {
      name: "범고래",
      scientific: "Orcinus orca",
      score:
        14 +
        Number(isWhistle) * 30 +
        Number(isClickTrain) * 13 +
        bandFit(dominantFrequency, 400, 12000) * 21 +
        bandFit(spectralCentroid, 900, 10000) * 10,
      reason: "휘파람·펄스 호출과 중·고주파 에너지",
    },
    {
      name: "큰돌고래",
      scientific: "Tursiops truncatus",
      score:
        14 +
        Number(isWhistle) * 34 +
        Number(isClickTrain) * 9 +
        bandFit(dominantFrequency, 1000, 16000) * 23 +
        bandFit(spectralCentroid, 1800, 18000) * 9,
      reason: "시그니처 휘슬 또는 빠른 반향정위 클릭",
    },
    {
      name: "참고래류",
      scientific: "Eubalaena spp.",
      score:
        11 +
        Number(isSustained) * 24 +
        bandFit(dominantFrequency, 50, 1000) * 32 +
        tonalFit * 8,
      reason: "낮은 주파수의 상승형·접촉성 호출음",
    },
  ];

  return profiles
    .map((profile) => ({
      ...profile,
      score: Math.round(clamp(profile.score, 5, 88)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function bandFit(value, low, high) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= low && value <= high) return 1;
  const edge = value < low ? low : high;
  return Math.exp(-Math.abs(Math.log2(value / edge)) * 1.15);
}

function showAnalysis(analysis, duration) {
  metricElements.dominantFrequency.textContent = formatFrequency(analysis.dominantFrequency);
  metricElements.spectralCentroid.textContent = formatFrequency(analysis.spectralCentroid);
  metricElements.eventCount.textContent = String(analysis.events.length);
  metricElements.pulseRate.textContent = analysis.pulseRate ? `${analysis.pulseRate.toFixed(2)} Hz` : "불규칙";
  metricElements.patternGlyph.textContent = analysis.pattern.glyph;
  metricElements.patternName.textContent = analysis.pattern.name;
  metricElements.patternDescription.textContent = analysis.pattern.description;
  metricElements.confidenceValue.textContent = `${Math.round(analysis.pattern.confidence)}%`;
  metricElements.confidenceBar.style.width = `${analysis.pattern.confidence}%`;
  showSpeciesCandidates(analysis.speciesCandidates);

  eventTimeline.replaceChildren();
  analysis.events.slice(0, 160).forEach((time) => {
    const marker = document.createElement("i");
    marker.style.left = `${clamp((time / duration) * 100, 0, 99.5)}%`;
    marker.title = formatDuration(time);
    eventTimeline.append(marker);
  });
}

function showSpeciesCandidates(candidates) {
  speciesCandidatesElement.replaceChildren();
  candidates.forEach((candidate, index) => {
    const card = document.createElement("article");
    card.className = `species-card species-rank-${index + 1}`;

    const rank = document.createElement("div");
    rank.className = "species-rank";
    rank.innerHTML = `<span>가능성 ${index + 1}위</span><strong>일치도 ${candidate.score}%</strong>`;

    const name = document.createElement("h3");
    name.textContent = candidate.name;
    const scientific = document.createElement("small");
    scientific.textContent = candidate.scientific;
    const reason = document.createElement("p");
    reason.textContent = candidate.reason;

    card.append(rank, name, scientific, reason);
    speciesCandidatesElement.append(card);
  });
}

function drawWaveform(data) {
  const { context, width, height } = prepareCanvas(waveformCanvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#071719";
  context.fillRect(0, 0, width, height);
  drawGrid(context, width, height, 8, 4);

  const center = height / 2;
  const samplesPerPixel = Math.max(1, Math.floor(data.length / width));
  context.strokeStyle = "#48e7cf";
  context.lineWidth = 1;
  context.beginPath();

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * data.length / width);
    let min = 1;
    let max = -1;
    for (let i = 0; i < samplesPerPixel; i += 1) {
      const sample = data[start + i] || 0;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    context.moveTo(x, center + min * center * 0.86);
    context.lineTo(x, center + max * center * 0.86);
  }
  context.stroke();

  context.strokeStyle = "rgba(130, 255, 233, 0.25)";
  context.beginPath();
  context.moveTo(0, center + 0.5);
  context.lineTo(width, center + 0.5);
  context.stroke();
}

function drawSpectrogram(data, sampleRate) {
  const { context, width, height } = prepareCanvas(spectrogramCanvas);
  const fftSize = 512;
  const columns = Math.min(width, 520);
  const magnitudes = [];
  let globalMax = -Infinity;

  for (let column = 0; column < columns; column += 1) {
    const center = Math.floor((column / Math.max(1, columns - 1)) * Math.max(0, data.length - 1));
    const start = center - fftSize / 2;
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);

    for (let i = 0; i < fftSize; i += 1) {
      const sample = data[start + i] || 0;
      real[i] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1)));
    }

    fft(real, imag);
    const columnData = new Float32Array(fftSize / 2);
    for (let bin = 1; bin < fftSize / 2; bin += 1) {
      const db = 20 * Math.log10(Math.hypot(real[bin], imag[bin]) + 1e-7);
      columnData[bin] = db;
      globalMax = Math.max(globalMax, db);
    }
    magnitudes.push(columnData);
  }

  const image = context.createImageData(width, height);
  const maxFrequency = sampleRate / 2;
  for (let x = 0; x < width; x += 1) {
    const column = magnitudes[Math.min(columns - 1, Math.floor((x / width) * columns))];
    for (let y = 0; y < height; y += 1) {
      const ratio = 1 - y / height;
      const frequency = Math.pow(ratio, 2.2) * maxFrequency;
      const bin = clamp(Math.round((frequency / maxFrequency) * (fftSize / 2 - 1)), 1, fftSize / 2 - 1);
      const intensity = clamp((column[bin] - (globalMax - 64)) / 64, 0, 1);
      const [red, green, blue] = spectrogramColor(intensity);
      const offset = (y * width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  context.globalCompositeOperation = "screen";
  drawGrid(context, width, height, 10, 5);
  context.globalCompositeOperation = "source-over";
}

function fft(real, imag) {
  const size = real.length;
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let wr = 1;
      let wi = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * wr - imag[odd] * wi;
        const oddImag = real[odd] * wi + imag[odd] * wr;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextWr = wr * cosine - wi * sine;
        wi = wr * sine + wi * cosine;
        wr = nextWr;
      }
    }
  }
}

function spectrogramColor(value) {
  const stops = [
    [3, 15, 18],
    [8, 49, 53],
    [15, 111, 109],
    [36, 210, 181],
    [151, 250, 215],
    [235, 245, 151],
  ];
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  return stops[index].map((channel, i) => Math.round(channel + (stops[index + 1][i] - channel) * mix));
}

function drawGrid(context, width, height, columns, rows) {
  context.strokeStyle = "rgba(125, 177, 176, 0.08)";
  context.lineWidth = 1;
  for (let i = 1; i < columns; i += 1) {
    const x = (i / columns) * width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let i = 1; i < rows; i += 1) {
    const y = (i / rows) * height;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function prepareCanvas(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { context: canvas.getContext("2d"), width, height };
}

function createSample(type) {
  const context = getAudioContext();
  const sampleRate = 16000;
  const duration = 7;
  const buffer = context.createBuffer(1, sampleRate * duration, sampleRate);
  const data = buffer.getChannelData(0);

  if (type === "clicks") {
    createClickSample(data, sampleRate);
    presentBuffer(buffer, "synthetic_click_train.wav", "합성 교육 예시 · 실제 종 녹음 아님");
  } else if (type === "song") {
    createSongSample(data, sampleRate);
    presentBuffer(buffer, "synthetic_modulated_song.wav", "합성 교육 예시 · 실제 종 녹음 아님");
  } else if (type === "whistle") {
    createWhistleSample(data, sampleRate);
    presentBuffer(buffer, "synthetic_whistle_calls.wav", "합성 교육 예시 · 실제 종 녹음 아님");
  } else {
    createDolphinSample(data, sampleRate);
    presentBuffer(buffer, "synthetic_dolphin_signature_whistle.wav", "돌고래형 합성 교육 예시 · 실제 개체 녹음 아님");
  }
}

function createClickSample(data, sampleRate) {
  const clickTimes = [0.5, 0.78, 1.06, 1.75, 2.02, 2.28, 2.54, 3.4, 3.72, 4.55, 4.82, 5.09, 5.36, 6.15];
  clickTimes.forEach((time, index) => {
    const start = Math.floor(time * sampleRate);
    const length = Math.floor(sampleRate * 0.018);
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.exp(-i / (sampleRate * 0.0028));
      const tone = Math.sin((2 * Math.PI * (1800 + (index % 3) * 620) * i) / sampleRate);
      const noise = Math.random() * 2 - 1;
      data[start + i] += (tone * 0.58 + noise * 0.42) * envelope * 0.8;
    }
  });
  addOceanNoise(data, 0.018);
}

function createSongSample(data, sampleRate) {
  for (let i = 0; i < data.length; i += 1) {
    const time = i / sampleRate;
    const phrase = time % 2.25;
    const frequency = 180 + 95 * Math.sin(time * 1.25) + phrase * 105;
    const envelope = Math.pow(Math.sin((Math.PI * phrase) / 2.25), 1.5);
    data[i] =
      envelope *
        (Math.sin(2 * Math.PI * frequency * time) * 0.54 +
          Math.sin(2 * Math.PI * frequency * 2.02 * time) * 0.19 +
          Math.sin(2 * Math.PI * frequency * 3.01 * time) * 0.08) +
      (Math.random() * 2 - 1) * 0.012;
  }
}

function createWhistleSample(data, sampleRate) {
  const calls = [
    [0.5, 1.65],
    [2.15, 3.25],
    [3.8, 5.05],
    [5.55, 6.55],
  ];
  calls.forEach(([startTime, endTime], callIndex) => {
    let phase = 0;
    const start = Math.floor(startTime * sampleRate);
    const end = Math.floor(endTime * sampleRate);
    for (let i = start; i < end; i += 1) {
      const progress = (i - start) / (end - start);
      const frequency =
        1250 + progress * (1900 + callIndex * 130) + Math.sin(progress * Math.PI * 3) * 260;
      phase += (2 * Math.PI * frequency) / sampleRate;
      const envelope = Math.sin(progress * Math.PI);
      data[i] += Math.sin(phase) * envelope * 0.66 + Math.sin(phase * 2) * envelope * 0.1;
    }
  });
  addOceanNoise(data, 0.008);
}

function createDolphinSample(data, sampleRate) {
  const whistleStarts = [0.35, 1.85, 3.35, 4.85];
  whistleStarts.forEach((startTime, phraseIndex) => {
    const duration = 1.05;
    const start = Math.floor(startTime * sampleRate);
    const end = Math.min(data.length, Math.floor((startTime + duration) * sampleRate));
    let phase = 0;

    for (let i = start; i < end; i += 1) {
      const progress = (i - start) / Math.max(1, end - start);
      const contour =
        2850 +
        progress * 1650 +
        Math.sin(progress * Math.PI * 2) * 520 +
        Math.sin(progress * Math.PI * 5) * 120;
      phase += (2 * Math.PI * contour) / sampleRate;
      const envelope = Math.pow(Math.sin(progress * Math.PI), 0.7);
      const signatureVariation = 1 + phraseIndex * 0.012;
      data[i] +=
        Math.sin(phase * signatureVariation) * envelope * 0.54 +
        Math.sin(phase * 2 * signatureVariation) * envelope * 0.055;
    }
  });

  const clickBursts = [
    [1.48, 5],
    [2.98, 6],
    [4.48, 7],
    [6.35, 8],
  ];
  clickBursts.forEach(([startTime, count]) => {
    for (let click = 0; click < count; click += 1) {
      const start = Math.floor((startTime + click * 0.045) * sampleRate);
      const length = Math.floor(sampleRate * 0.004);
      for (let i = 0; i < length && start + i < data.length; i += 1) {
        const envelope = Math.exp(-i / (sampleRate * 0.0007));
        data[start + i] += (Math.random() * 2 - 1) * envelope * 0.42;
      }
    }
  });

  addOceanNoise(data, 0.006);
}

function addOceanNoise(data, level) {
  let filtered = 0;
  for (let i = 0; i < data.length; i += 1) {
    filtered = filtered * 0.94 + (Math.random() * 2 - 1) * 0.06;
    data[i] += filtered * level;
  }
}

function togglePlayback() {
  if (!currentBuffer) return;
  if (playing) {
    pausedAt = Math.min(currentBuffer.duration, getPlaybackTime());
    stopSource();
    playing = false;
    updatePlaybackUi();
    return;
  }

  const context = getAudioContext();
  context.resume();
  if (pausedAt >= currentBuffer.duration) pausedAt = 0;
  currentSource = context.createBufferSource();
  currentSource.buffer = currentBuffer;
  currentSource.connect(context.destination);
  startedAt = context.currentTime - pausedAt;
  currentSource.start(0, pausedAt);
  currentSource.onended = () => {
    if (!playing) return;
    playing = false;
    pausedAt = currentBuffer.duration;
    updatePlaybackUi();
  };
  playing = true;
  updatePlaybackUi();
  animatePlayhead();
}

function stopPlayback() {
  stopSource();
  playing = false;
  pausedAt = 0;
  cancelAnimationFrame(playheadFrame);
  updatePlaybackUi();
}

function stopSource() {
  if (!currentSource) return;
  currentSource.onended = null;
  try {
    currentSource.stop();
  } catch {
    // The source may already have stopped.
  }
  currentSource.disconnect();
  currentSource = null;
}

function getPlaybackTime() {
  if (!currentBuffer) return 0;
  return playing ? clamp(getAudioContext().currentTime - startedAt, 0, currentBuffer.duration) : pausedAt;
}

function animatePlayhead() {
  cancelAnimationFrame(playheadFrame);
  const draw = () => {
    updatePlaybackUi();
    if (playing) playheadFrame = requestAnimationFrame(draw);
  };
  draw();
}

function updatePlaybackUi() {
  const current = getPlaybackTime();
  const duration = currentBuffer?.duration || 0;
  playIcon.textContent = playing ? "Ⅱ" : "▶";
  playLabel.textContent = playing ? "일시정지" : "재생";
  playhead.style.left = `${duration ? (current / duration) * 100 : 0}%`;
  timeReadout.textContent = `${formatDuration(current)} / ${formatDuration(duration)}`;
}

function seekFromPointer(event) {
  if (!currentBuffer) return;
  const bounds = waveformCanvas.getBoundingClientRect();
  pausedAt = clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * currentBuffer.duration;
  const wasPlaying = playing;
  stopSource();
  playing = false;
  if (wasPlaying) togglePlayback();
  else updatePlaybackUi();
}

function formatFrequency(value) {
  if (!Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${Math.round(value)} Hz`;
}

function formatRate(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${value} Hz`;
}

function formatDuration(value) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

audioInput.addEventListener("change", () => loadFile(audioInput.files[0]));
playButton.addEventListener("click", togglePlayback);
waveformCanvas.addEventListener("click", seekFromPointer);

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
});

dropZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));
document.querySelectorAll("[data-sample]").forEach((button) => {
  button.addEventListener("click", () => createSample(button.dataset.sample));
});

window.addEventListener("resize", () => {
  if (!currentBuffer) return;
  const mono = mixToMono(currentBuffer);
  drawWaveform(mono);
  drawSpectrogram(mono, currentBuffer.sampleRate);
});

const requestedSample = new URLSearchParams(window.location.search).get("sample");
if (["clicks", "song", "whistle", "dolphin"].includes(requestedSample)) {
  requestAnimationFrame(() => createSample(requestedSample));
}
