(function () {
  "use strict";

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_SOURCE_EDGE = 2800;
  const DEFAULTS = {
    mode: "pencil",
    intensity: 72,
    detail: 45,
    thickness: 2,
    cleanup: true,
    color: "#22211f",
    background: "#fbf8f0",
    view: "split"
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const elements = {
    fileInput: $("#fileInput"),
    dropzone: $("#dropzone"),
    dropzoneEmpty: $("#dropzoneEmpty"),
    dropzoneLoaded: $("#dropzoneLoaded"),
    fileThumbnail: $("#fileThumbnail"),
    fileName: $("#fileName"),
    fileMeta: $("#fileMeta"),
    originalImage: $("#originalImage"),
    originalEmpty: $("#originalEmpty"),
    originalWell: $("#originalWell"),
    originalDimensions: $("#originalDimensions"),
    originalFileSize: $("#originalFileSize"),
    resultCanvas: $("#resultCanvas"),
    resultEmpty: $("#resultEmpty"),
    resultDimensions: $("#resultDimensions"),
    processingTime: $("#processingTime"),
    overlayCompare: $("#overlayCompare"),
    overlayOriginal: $("#overlayOriginal"),
    overlayResult: $("#overlayResult"),
    overlayCanvas: $("#overlayCanvas"),
    compareLine: $("#compareLine"),
    previewGrid: $("#previewGrid"),
    previewStatus: $("#previewStatus"),
    previewPanel: $("#previewPanel"),
    processingOverlay: $("#processingOverlay"),
    processingTitle: $("#processingTitle"),
    processingDetail: $("#processingDetail"),
    progressBar: $("#progressBar"),
    progressValue: $("#progressValue"),
    dropOverlay: $("#dropOverlay"),
    intensityRange: $("#intensityRange"),
    intensityOutput: $("#intensityOutput"),
    detailRange: $("#detailRange"),
    detailOutput: $("#detailOutput"),
    thicknessRange: $("#thicknessRange"),
    thicknessOutput: $("#thicknessOutput"),
    cleanupToggle: $("#cleanupToggle"),
    customColor: $("#customColor"),
    convertButton: $("#convertButton"),
    convertButtonLabel: $("#convertButtonLabel"),
    downloadButton: $("#downloadButton"),
    toolbarDownloadButton: $("#toolbarDownloadButton"),
    resetButton: $("#resetButton"),
    tuneReset: $("#tuneReset"),
    fullscreenButton: $("#fullscreenButton"),
    helpButton: $("#helpButton"),
    helpDialog: $("#helpDialog"),
    dialogCloseButton: $("#dialogCloseButton"),
    toastRegion: $("#toastRegion")
  };

  const state = {
    sourceCanvas: null,
    sourceWidth: 0,
    sourceHeight: 0,
    sourceFile: null,
    sourceUrl: null,
    thumbnailUrl: null,
    mask: null,
    processing: false,
    loadRevision: 0,
    resultRevision: 0,
    activeWorker: null,
    pendingProcess: false,
    comparePercent: 50,
    ...DEFAULTS
  };

  elements.resultCanvas.hidden = true;
  elements.overlayCanvas.hidden = true;
  elements.overlayOriginal.hidden = true;

  Object.values(elements).forEach((element) => {
    if (!element) return;
  });

  function updateRangeFill(range) {
    const min = Number(range.min);
    const max = Number(range.max);
    const value = Number(range.value);
    const percentage = ((value - min) / (max - min)) * 100;
    range.style.setProperty("--range-fill", `${percentage}%`);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDimensions(width, height) {
    return `${width.toLocaleString("zh-CN")} × ${height.toLocaleString("zh-CN")} px`;
  }

  function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith("image/")) return true;
    return /\.(jpe?g|png|webp|gif|bmp|svg|avif|heic|heif)$/i.test(file.name || "");
  }

  function showToast(message, kind) {
    const toast = document.createElement("div");
    toast.className = `toast${kind === "error" ? " error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 3300);
  }

  function setStatus(text, mode) {
    elements.previewStatus.className = `preview-status${mode ? ` ${mode}` : ""}`;
    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    elements.previewStatus.replaceChildren(
      dot,
      document.createTextNode(text)
    );
  }

  function setProgress(progress, detail) {
    const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    elements.progressBar.style.width = `${percent}%`;
    elements.progressValue.textContent = `${percent}%`;
    if (detail) {
      elements.processingDetail.textContent = detail;
    }
  }

  function setProcessing(active) {
    state.processing = active;
    elements.processingOverlay.hidden = !active;
    elements.convertButton.disabled = !state.sourceCanvas || active;
    elements.dropzone.setAttribute("aria-busy", active ? "true" : "false");

    if (active) {
      elements.convertButtonLabel.textContent = "Drawing...";
      setStatus("Rendering", "working");
    } else {
      elements.convertButton.disabled = !state.sourceCanvas;
      elements.convertButtonLabel.textContent = state.mask
        ? "Generate again"
        : "Generate line art";
    }
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function canvasToBlob(canvas, type) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not create an image file"));
      }, type || "image/png");
    });
  }

  function loadHtmlImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode image"));
      image.src = url;
    });
  }

  async function decodeImage(file) {
    let bitmap = null;

    if ("createImageBitmap" in window) {
      try {
        bitmap = await createImageBitmap(file);
      } catch (error) {
        // SVG and a few browser-specific formats decode more reliably through
        // an HTMLImageElement. The shared object URL fallback below handles it.
      }
    }

    if (bitmap) return bitmap;

    const objectUrl = URL.createObjectURL(file);
    try {
      return await loadHtmlImage(objectUrl);
    } finally {
      // The decoded image owns its pixels by this point. Revoke on the next
      // task so browsers that lazy-copy image data have time to finish.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  }

  function releaseUrls() {
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    if (state.thumbnailUrl) URL.revokeObjectURL(state.thumbnailUrl);
    state.sourceUrl = null;
    state.thumbnailUrl = null;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!isImageFile(file)) {
      showToast("Choose a JPG, PNG, WebP, or other image file", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast("Image exceeds 50 MB. Please compress it and try again.", "error");
      return;
    }

    const revision = ++state.loadRevision;
    state.resultRevision += 1;
    state.pendingProcess = false;
    if (state.activeWorker) {
      state.activeWorker.terminate();
      state.activeWorker = null;
    }

    setProcessing(true);
    setProgress(0.035, "Reading image");
    elements.processingTitle.textContent = "Preparing canvas...";

    let decodedImage;
    try {
      decodedImage = await decodeImage(file);
    } catch (error) {
      if (revision !== state.loadRevision) return;
      setProcessing(false);
      setStatus("Read failed");
      showToast(
        "Could not read this image. Convert HEIC files to JPG or PNG first.",
        "error"
      );
      return;
    }

    if (revision !== state.loadRevision) {
      if (typeof decodedImage.close === "function") decodedImage.close();
      return;
    }

    const rawWidth = decodedImage.naturalWidth || decodedImage.width;
    const rawHeight = decodedImage.naturalHeight || decodedImage.height;
    if (!rawWidth || !rawHeight) {
      setProcessing(false);
      showToast("Invalid image dimensions. Try another image.", "error");
      return;
    }

    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(rawWidth, rawHeight));
    const width = Math.max(1, Math.round(rawWidth * scale));
    const height = Math.max(1, Math.round(rawHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", {
      alpha: true,
      willReadFrequently: true
    });

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decodedImage, 0, 0, width, height);
    if (typeof decodedImage.close === "function") decodedImage.close();

    let previewBlob;
    try {
      previewBlob = await canvasToBlob(canvas, "image/png");
    } catch (error) {
      setProcessing(false);
      showToast("Could not create a preview. Try another image.", "error");
      return;
    }

    if (revision !== state.loadRevision) return;

    releaseUrls();
    state.sourceUrl = URL.createObjectURL(previewBlob);
    state.thumbnailUrl = URL.createObjectURL(previewBlob);
    state.sourceCanvas = canvas;
    state.sourceWidth = width;
    state.sourceHeight = height;
    state.sourceFile = file;
    state.mask = null;

    elements.fileThumbnail.src = state.thumbnailUrl;
    elements.fileName.textContent = file.name || "clipboard-image.png";
    elements.fileMeta.textContent = `${formatDimensions(width, height)} · ${formatBytes(
      file.size
    )}`;
    elements.dropzoneEmpty.hidden = true;
    elements.dropzoneLoaded.hidden = false;

    elements.originalImage.src = state.sourceUrl;
    elements.originalImage.hidden = false;
    elements.originalEmpty.hidden = true;
    elements.originalDimensions.textContent = formatDimensions(width, height);
    elements.originalFileSize.textContent = formatBytes(file.size);
    elements.resultDimensions.textContent = "Pending";
    elements.processingTime.textContent = "—";

    elements.overlayOriginal.src = state.sourceUrl;
    elements.overlayOriginal.hidden = false;
    elements.overlayCanvas.hidden = true;
    elements.overlayCompare.style.aspectRatio = `${width} / ${height}`;
    elements.resultCanvas.hidden = true;
    elements.resultEmpty.hidden = false;
    elements.downloadButton.disabled = true;
    elements.toolbarDownloadButton.disabled = true;
    elements.convertButton.disabled = false;

    if (width > height * 1.15) {
      setView("overlay");
    }

    setProgress(0.08, "Preparing line extraction");
    elements.processingTitle.textContent = "Preparing canvas...";
    setProcessing(false);
    await processImage(true);
  }

  async function runWorker(imageData, options, revision) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker("./line-art-worker.js");
      } catch (error) {
        reject(error);
        return;
      }

      state.activeWorker = worker;
      const timeout = window.setTimeout(() => {
        worker.terminate();
        if (state.activeWorker === worker) state.activeWorker = null;
        reject(new Error("Processing timed out"));
      }, 45000);

      const finish = (callback, value) => {
        window.clearTimeout(timeout);
        worker.terminate();
        if (state.activeWorker === worker) state.activeWorker = null;
        callback(value);
      };

      worker.onmessage = (event) => {
        const message = event.data;
        if (message.id !== revision) return;

        if (message.type === "progress") {
          setProgress(message.progress, message.detail);
          return;
        }

        if (message.type === "result") {
          finish(resolve, {
            mask: new Float32Array(message.mask),
            width: message.width,
            height: message.height,
            duration: message.duration
          });
          return;
        }

        if (message.type === "error") {
          finish(reject, new Error(message.message || "Line extraction failed"));
        }
      };

      worker.onerror = (event) => {
        finish(reject, new Error(event.message || "Worker failed to start"));
      };

      const buffer = imageData.data.buffer;
      worker.postMessage(
        {
          id: revision,
          data: buffer,
          width: imageData.width,
          height: imageData.height,
          options
        },
        [buffer]
      );
    });
  }

  async function runLocalFallback(imageData, options, revision) {
    setProgress(0.12, "Using compatibility mode");
    await nextPaint();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    if (revision !== state.resultRevision) {
      throw new Error("Processing cancelled");
    }

    setProgress(0.28, "Tracing contours");
    const result = window.LineArtEngine.process(
      imageData.data,
      imageData.width,
      imageData.height,
      options
    );
    return result;
  }

  function parseHexColor(hex) {
    const normalized = String(hex || "").replace("#", "");
    const value =
      normalized.length === 3
        ? normalized
            .split("")
            .map((character) => character + character)
            .join("")
        : normalized.padEnd(6, "0").slice(0, 6);
    return {
      r: parseInt(value.slice(0, 2), 16) || 0,
      g: parseInt(value.slice(2, 4), 16) || 0,
      b: parseInt(value.slice(4, 6), 16) || 0
    };
  }

  function renderMask(canvas, mask, width, height, lineColor, background) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    const output = context.createImageData(width, height);
    const line = parseHexColor(lineColor);
    const transparent = background === "transparent";
    const paper = transparent ? { r: 255, g: 255, b: 255 } : parseHexColor(background);

    for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
      const alpha = Math.max(0, Math.min(1, mask[i]));
      if (transparent) {
        output.data[p] = line.r;
        output.data[p + 1] = line.g;
        output.data[p + 2] = line.b;
        output.data[p + 3] = Math.round(alpha * 255);
      } else {
        output.data[p] = Math.round(line.r * alpha + paper.r * (1 - alpha));
        output.data[p + 1] = Math.round(line.g * alpha + paper.g * (1 - alpha));
        output.data[p + 2] = Math.round(line.b * alpha + paper.b * (1 - alpha));
        output.data[p + 3] = 255;
      }
    }

    context.putImageData(output, 0, 0);
  }

  function renderOutputs() {
    if (!state.mask) return;
    renderMask(
      elements.resultCanvas,
      state.mask,
      state.sourceWidth,
      state.sourceHeight,
      state.color,
      state.background
    );
    renderMask(
      elements.overlayCanvas,
      state.mask,
      state.sourceWidth,
      state.sourceHeight,
      state.color,
      state.background
    );

    elements.resultCanvas.hidden = false;
    elements.overlayCanvas.hidden = false;
    elements.resultEmpty.hidden = true;
    elements.downloadButton.disabled = false;
    elements.toolbarDownloadButton.disabled = false;
  }

  async function processImage(announce) {
    if (!state.sourceCanvas) return;
    if (state.processing) {
      state.pendingProcess = true;
      return;
    }

    const revision = ++state.resultRevision;
    setProcessing(true);
    setProgress(0.02, "Preparing line extraction");
    elements.processingTitle.textContent = "Preparing canvas...";

    const context = state.sourceCanvas.getContext("2d", {
      alpha: true,
      willReadFrequently: true
    });
    const imageData = context.getImageData(
      0,
      0,
      state.sourceWidth,
      state.sourceHeight
    );
    const options = {
      mode: state.mode,
      intensity: state.intensity,
      detail: state.detail,
      thickness: state.thickness,
      cleanup: state.cleanup
    };

    let result;
    try {
      if (window.Worker && window.location.protocol !== "file:") {
        try {
          result = await runWorker(imageData, options, revision);
        } catch (workerError) {
          if (revision !== state.resultRevision) return;
          const freshData = context.getImageData(
            0,
            0,
            state.sourceWidth,
            state.sourceHeight
          );
          result = await runLocalFallback(freshData, options, revision);
        }
      } else {
        result = await runLocalFallback(imageData, options, revision);
      }
    } catch (error) {
      if (revision !== state.resultRevision) return;
      setProcessing(false);
      setStatus("Render failed");
      showToast(`Render failed: ${error.message || "Try another image."}`, "error");
      if (state.pendingProcess) {
        state.pendingProcess = false;
        processImage(false);
      }
      return;
    }

    if (revision !== state.resultRevision) return;

    state.mask = result.mask;
    renderOutputs();
    setProgress(1, "Finishing artwork");
    elements.processingTime.textContent = `${(result.duration / 1000).toFixed(1)}s`;
    elements.resultDimensions.textContent = formatDimensions(
      state.sourceWidth,
      state.sourceHeight
    );
    setStatus("Line art ready", "ready");
    setProcessing(false);

    if (announce) {
      showToast("Line art ready. Adjust or download.");
    }

    if (state.pendingProcess) {
      state.pendingProcess = false;
      processImage(false);
    }
  }

  let processTimer = 0;
  function scheduleProcess(delay, announce) {
    window.clearTimeout(processTimer);
    processTimer = window.setTimeout(() => processImage(Boolean(announce)), delay);
  }

  function setView(view) {
    if (view === "overlay" && !state.sourceCanvas) {
      showToast("Upload an image first", "error");
      return;
    }

    state.view = view;
    $$("[data-view]").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });

    const overlay = view === "overlay";
    elements.previewGrid.classList.toggle("overlay-mode", overlay);
    elements.overlayCompare.hidden = !overlay;
    $$(".image-frame", elements.previewGrid).forEach((frame) => {
      frame.hidden = overlay;
    });

    if (overlay) {
      setComparePercent(state.comparePercent);
      renderOutputs();
    }
  }

  function setComparePercent(value) {
    state.comparePercent = Math.max(2, Math.min(98, value));
    const percent = `${state.comparePercent}%`;
    elements.overlayResult.style.clipPath = `inset(0 0 0 ${percent})`;
    elements.compareLine.style.left = percent;
  }

  function setMode(mode) {
    state.mode = mode;
    $$(".style-option").forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    if (state.sourceCanvas) scheduleProcess(80);
  }

  function selectLineColor(color) {
    state.color = color;
    $$(".color-swatch").forEach((button) => {
      const active = button.dataset.color.toLowerCase() === color.toLowerCase();
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    const customLabel = elements.customColor.closest(".custom-color");
    const isCustom = !$$(".color-swatch").some(
      (button) => button.dataset.color.toLowerCase() === color.toLowerCase()
    );
    customLabel.classList.toggle("active", isCustom);
    if (isCustom) elements.customColor.value = color;
    renderOutputs();
  }

  function selectBackground(background) {
    state.background = background;
    $$(".paper-option").forEach((button) => {
      const active = button.dataset.background === background;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    });
    renderOutputs();
  }

  function syncControls() {
    elements.intensityRange.value = state.intensity;
    elements.detailRange.value = state.detail;
    elements.thicknessRange.value = state.thickness;
    elements.cleanupToggle.checked = state.cleanup;
    elements.intensityOutput.value = state.intensity;
    elements.detailOutput.value = state.detail;
    const thicknessLabels = { 1: "Thin", 2: "Balanced", 3: "Bold" };
    elements.thicknessOutput.value = thicknessLabels[state.thickness];
    updateRangeFill(elements.intensityRange);
    updateRangeFill(elements.detailRange);
    updateRangeFill(elements.thicknessRange);
    setMode(state.mode);
    selectLineColor(state.color);
    selectBackground(state.background);
  }

  function resetTuning(shouldProcess) {
    state.intensity = DEFAULTS.intensity;
    state.detail = DEFAULTS.detail;
    state.thickness = DEFAULTS.thickness;
    state.cleanup = DEFAULTS.cleanup;
    elements.intensityRange.value = state.intensity;
    elements.detailRange.value = state.detail;
    elements.thicknessRange.value = state.thickness;
    elements.cleanupToggle.checked = state.cleanup;
    elements.intensityOutput.value = state.intensity;
    elements.detailOutput.value = state.detail;
    elements.thicknessOutput.value = "Balanced";
    updateRangeFill(elements.intensityRange);
    updateRangeFill(elements.detailRange);
    updateRangeFill(elements.thicknessRange);
    if (shouldProcess && state.sourceCanvas) scheduleProcess(80, true);
  }

  function resetAll() {
    state.mode = DEFAULTS.mode;
    state.color = DEFAULTS.color;
    state.background = DEFAULTS.background;
    resetTuning(false);
    setMode(state.mode);
    selectLineColor(state.color);
    selectBackground(state.background);
    if (state.sourceCanvas) scheduleProcess(80, true);
    showToast("Settings reset");
  }

  function openFilePicker() {
    elements.fileInput.click();
  }

  async function downloadResult() {
    if (!state.mask || !state.sourceCanvas) {
      showToast("Generate line art first", "error");
      return;
    }

    const exportCanvas = document.createElement("canvas");
    renderMask(
      exportCanvas,
      state.mask,
      state.sourceWidth,
      state.sourceHeight,
      state.color,
      state.background
    );

    try {
      const blob = await canvasToBlob(exportCanvas, "image/png");
      const url = URL.createObjectURL(blob);
      const baseName = (state.sourceFile?.name || "line-art")
        .replace(/\.[^.]+$/, "")
        .replace(/[\\/:*?"<>|]/g, "-")
        .slice(0, 80);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${baseName || "line-art"}-line-art.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast("PNG download started");
    } catch (error) {
      showToast("Download failed. Try again.", "error");
    }
  }

  function renderDroppedFile(files) {
    const file = Array.from(files || []).find(isImageFile);
    if (file) handleFile(file);
    else if (files && files.length) showToast("That file is not an image", "error");
  }

  function setupDropEvents() {
    ["dragenter", "dragover"].forEach((type) => {
      window.addEventListener(type, (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        elements.dropOverlay.hidden = false;
      });
    });

    window.addEventListener("dragleave", (event) => {
      if (
        event.clientX <= 0 ||
        event.clientY <= 0 ||
        event.clientX >= window.innerWidth ||
        event.clientY >= window.innerHeight
      ) {
        elements.dropOverlay.hidden = true;
      }
    });

    window.addEventListener("drop", (event) => {
      event.preventDefault();
      elements.dropOverlay.hidden = true;
      elements.dropzone.classList.remove("drag-over");
      renderDroppedFile(event.dataTransfer?.files);
    });

    elements.dropzone.addEventListener("dragenter", () => {
      elements.dropzone.classList.add("drag-over");
    });
    elements.dropzone.addEventListener("dragleave", () => {
      elements.dropzone.classList.remove("drag-over");
    });
  }

  function setupCompareDrag() {
    let dragging = false;

    const update = (event) => {
      const bounds = elements.overlayCompare.getBoundingClientRect();
      const percentage = ((event.clientX - bounds.left) / bounds.width) * 100;
      setComparePercent(percentage);
    };

    elements.overlayCompare.addEventListener("pointerdown", (event) => {
      dragging = true;
      elements.overlayCompare.setPointerCapture(event.pointerId);
      update(event);
    });
    elements.overlayCompare.addEventListener("pointermove", (event) => {
      if (dragging) update(event);
    });
    elements.overlayCompare.addEventListener("pointerup", (event) => {
      dragging = false;
      if (elements.overlayCompare.hasPointerCapture(event.pointerId)) {
        elements.overlayCompare.releasePointerCapture(event.pointerId);
      }
    });
    elements.overlayCompare.addEventListener("pointercancel", () => {
      dragging = false;
    });
  }

  function setupEvents() {
    elements.dropzone.addEventListener("click", openFilePicker);
    elements.dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFilePicker();
      }
    });

    elements.fileInput.addEventListener("change", () => {
      const [file] = elements.fileInput.files;
      if (file) handleFile(file);
      elements.fileInput.value = "";
    });

    $$(".style-option").forEach((button) => {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    });

    elements.intensityRange.addEventListener("input", () => {
      state.intensity = Number(elements.intensityRange.value);
      elements.intensityOutput.value = state.intensity;
      updateRangeFill(elements.intensityRange);
      scheduleProcess(240);
    });

    elements.detailRange.addEventListener("input", () => {
      state.detail = Number(elements.detailRange.value);
      elements.detailOutput.value = state.detail;
      updateRangeFill(elements.detailRange);
      scheduleProcess(240);
    });

    elements.thicknessRange.addEventListener("input", () => {
      state.thickness = Number(elements.thicknessRange.value);
      elements.thicknessOutput.value = { 1: "Thin", 2: "Balanced", 3: "Bold" }[
        state.thickness
      ];
      updateRangeFill(elements.thicknessRange);
      scheduleProcess(180);
    });

    elements.cleanupToggle.addEventListener("change", () => {
      state.cleanup = elements.cleanupToggle.checked;
      scheduleProcess(80);
    });

    $$(".color-swatch").forEach((button) => {
      button.addEventListener("click", () => selectLineColor(button.dataset.color));
    });

    elements.customColor.addEventListener("input", () => {
      selectLineColor(elements.customColor.value);
    });

    $$(".paper-option").forEach((button) => {
      button.addEventListener("click", () =>
        selectBackground(button.dataset.background)
      );
    });

    $$("[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });

    elements.convertButton.addEventListener("click", () => {
      if (!state.sourceCanvas) {
        openFilePicker();
        return;
      }
      processImage(true);
    });

    [elements.downloadButton, elements.toolbarDownloadButton].forEach((button) => {
      button.addEventListener("click", downloadResult);
    });

    elements.resetButton.addEventListener("click", resetAll);
    elements.tuneReset.addEventListener("click", () => resetTuning(true));

    elements.helpButton.addEventListener("click", () => {
      elements.helpDialog.showModal();
    });
    elements.dialogCloseButton.addEventListener("click", () => {
      elements.helpDialog.close();
    });
    elements.helpDialog.addEventListener("click", (event) => {
      const bounds = elements.helpDialog.getBoundingClientRect();
      const inside =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!inside) elements.helpDialog.close();
    });

    elements.fullscreenButton.addEventListener("click", async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else if (elements.previewPanel.requestFullscreen) {
          await elements.previewPanel.requestFullscreen();
        } else {
          showToast("Fullscreen preview is not supported", "error");
        }
      } catch (error) {
        showToast("Could not open fullscreen preview", "error");
      }
    });

    document.addEventListener("paste", (event) => {
      const file = Array.from(event.clipboardData?.files || []).find(isImageFile);
      if (file) {
        event.preventDefault();
        handleFile(file);
      }
    });

    document.addEventListener("keydown", (event) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;

      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        openFilePicker();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        downloadResult();
      }
      if (event.key === "Enter" && state.sourceCanvas) {
        event.preventDefault();
        processImage(true);
      }
    });

    setupDropEvents();
    setupCompareDrag();
  }

  function initialize() {
    syncControls();
    setView(DEFAULTS.view);
    setupEvents();
    updateRangeFill(elements.intensityRange);
    updateRangeFill(elements.detailRange);
    updateRangeFill(elements.thicknessRange);

    if (!window.LineArtEngine) {
      elements.convertButton.disabled = true;
      showToast("Line-art engine failed to load. Refresh the page.", "error");
    }
  }

  initialize();
})();
