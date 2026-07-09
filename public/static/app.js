/**
 * ClipForge — Frontend Application Logic
 * Manages UI state machine, API calls, and dual-thumb range slider.
 */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // DOM references
  // -----------------------------------------------------------------------
  const $urlInput     = document.getElementById("url-input");
  const $btnClear     = document.getElementById("btn-clear");
  const $btnFetch     = document.getElementById("btn-fetch");
  const $urlError     = document.getElementById("url-error");

  const $videoInfo    = document.getElementById("video-info");
  const $videoThumb   = document.getElementById("video-thumb");
  const $videoTitle   = document.getElementById("video-title");
  const $videoChannel = document.getElementById("video-channel");
  const $videoDur     = document.getElementById("video-duration");

  const $slicerSec    = document.getElementById("slicer-section");
  const $btnResetTrim = document.getElementById("btn-reset-trim");
  const $sliderStart  = document.getElementById("slider-start");
  const $sliderEnd    = document.getElementById("slider-end");
  const $sliderRange  = document.getElementById("slider-range");
  const $sliderSLabel = document.getElementById("slider-start-label");
  const $sliderELabel = document.getElementById("slider-end-label");
  const $inputStart   = document.getElementById("input-start");
  const $inputEnd     = document.getElementById("input-end");

  const $btnDownload  = document.getElementById("btn-download");
  const $dlIdle       = $btnDownload.querySelector(".btn-dl-idle");
  const $dlBusy       = $btnDownload.querySelector(".btn-dl-busy");
  const $dlDone       = $btnDownload.querySelector(".btn-dl-done");
  const $dlError      = document.getElementById("download-error");

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let videoDuration = 0;   // total seconds
  let currentURL    = "";
  let isBusy        = false;

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Seconds → HH:MM:SS */
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
  }

  /** HH:MM:SS or MM:SS or raw seconds → seconds (NaN on bad input) */
  function parseTime(str) {
    str = (str || "").trim();
    if (!str) return NaN;

    // raw number
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

    const parts = str.split(":");
    if (parts.length === 3) {
      return (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
    }
    if (parts.length === 2) {
      return (+parts[0]) * 60 + (+parts[1]);
    }
    return NaN;
  }

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function hideError(el) {
    el.textContent = "";
    el.classList.add("hidden");
  }

  /** Quick YouTube URL client-side check */
  function looksLikeYT(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/).+/.test(url.trim());
  }

  // -----------------------------------------------------------------------
  // Clear / reset helpers
  // -----------------------------------------------------------------------

  function resetAll() {
    videoDuration = 0;
    currentURL    = "";
    $videoInfo.classList.add("hidden");
    $slicerSec.classList.add("hidden");
    $btnDownload.classList.add("hidden");
    hideError($urlError);
    hideError($dlError);
    setDownloadState("idle");
  }

  $btnClear.addEventListener("click", () => {
    $urlInput.value = "";
    $btnClear.classList.add("hidden");
    resetAll();
    $urlInput.focus();
  });

  $urlInput.addEventListener("input", () => {
    $btnClear.classList.toggle("hidden", !$urlInput.value);
  });

  // -----------------------------------------------------------------------
  // Range slider logic
  // -----------------------------------------------------------------------

  function updateSliderUI() {
    const min = +$sliderStart.min;
    const max = +$sliderStart.max;
    const span = max - min || 1;
    const sVal = +$sliderStart.value;
    const eVal = +$sliderEnd.value;

    const leftPct  = ((sVal - min) / span) * 100;
    const rightPct = ((eVal - min) / span) * 100;

    $sliderRange.style.left  = leftPct + "%";
    $sliderRange.style.width = (rightPct - leftPct) + "%";

    const startSec = (sVal / max) * videoDuration;
    const endSec   = (eVal / max) * videoDuration;

    $sliderSLabel.textContent = fmtTime(startSec);
    $sliderELabel.textContent = fmtTime(endSec);
  }

  function syncInputsFromSlider() {
    const max = +$sliderStart.max;
    $inputStart.value = fmtTime((+$sliderStart.value / max) * videoDuration);
    $inputEnd.value   = fmtTime((+$sliderEnd.value   / max) * videoDuration);
  }

  function onSliderInput(e) {
    let sVal = +$sliderStart.value;
    let eVal = +$sliderEnd.value;

    // Prevent crossover
    if (e.target === $sliderStart && sVal > eVal) {
      $sliderStart.value = eVal;
    }
    if (e.target === $sliderEnd && eVal < sVal) {
      $sliderEnd.value = sVal;
    }

    updateSliderUI();
    syncInputsFromSlider();
  }

  $sliderStart.addEventListener("input", onSliderInput);
  $sliderEnd.addEventListener("input", onSliderInput);

  // Sync text → slider
  function syncSliderFromInputs() {
    const max = +$sliderStart.max;
    const s = parseTime($inputStart.value);
    const e = parseTime($inputEnd.value);

    if (!isNaN(s) && s >= 0 && s <= videoDuration) {
      $sliderStart.value = Math.round((s / videoDuration) * max);
    }
    if (!isNaN(e) && e >= 0 && e <= videoDuration) {
      $sliderEnd.value = Math.round((e / videoDuration) * max);
    }
    updateSliderUI();
  }

  $inputStart.addEventListener("change", syncSliderFromInputs);
  $inputEnd.addEventListener("change", syncSliderFromInputs);

  $btnResetTrim.addEventListener("click", () => {
    $sliderStart.value = 0;
    $sliderEnd.value   = +$sliderEnd.max;
    updateSliderUI();
    syncInputsFromSlider();
  });

  // -----------------------------------------------------------------------
  // Fetch video info
  // -----------------------------------------------------------------------

  async function fetchVideoInfo() {
    if (isBusy) return;

    const url = $urlInput.value.trim();
    hideError($urlError);
    hideError($dlError);

    if (!url) {
      showError($urlError, "Please paste a YouTube URL.");
      return;
    }
    if (!looksLikeYT(url)) {
      showError($urlError, "This doesn't look like a valid YouTube link.");
      return;
    }

    // UI: busy state
    isBusy = true;
    $btnFetch.disabled = true;
    $btnFetch.querySelector(".btn-label").classList.add("hidden");
    $btnFetch.querySelector(".btn-spinner").classList.remove("hidden");
    resetAll();

    try {
      const res = await fetch("/api/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Server error (${res.status})`);
      }

      const data = await res.json();
      currentURL    = url;
      videoDuration = data.duration || 0;

      // Populate info card
      $videoThumb.src          = data.thumbnail || "";
      $videoTitle.textContent   = data.title || "Untitled";
      $videoChannel.textContent = data.channel || "";
      $videoDur.textContent     = fmtTime(videoDuration);

      // Show cards
      $videoInfo.classList.remove("hidden");
      $slicerSec.classList.remove("hidden");
      $btnDownload.classList.remove("hidden");
      $btnDownload.disabled = false;

      // Init slider
      const sliderMax = 1000; // granularity
      $sliderStart.max = sliderMax;
      $sliderEnd.max   = sliderMax;
      $sliderStart.value = 0;
      $sliderEnd.value   = sliderMax;
      updateSliderUI();
      syncInputsFromSlider();

    } catch (err) {
      showError($urlError, err.message);
    } finally {
      isBusy = false;
      $btnFetch.disabled = false;
      $btnFetch.querySelector(".btn-label").classList.remove("hidden");
      $btnFetch.querySelector(".btn-spinner").classList.add("hidden");
    }
  }

  $btnFetch.addEventListener("click", fetchVideoInfo);
  $urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fetchVideoInfo();
  });

  // -----------------------------------------------------------------------
  // Download
  // -----------------------------------------------------------------------

  function setDownloadState(state) {
    $dlIdle.classList.toggle("hidden", state !== "idle");
    $dlBusy.classList.toggle("hidden", state !== "busy");
    $dlDone.classList.toggle("hidden", state !== "done");

    $btnDownload.classList.toggle("is-busy", state === "busy");
    $btnDownload.classList.toggle("is-done", state === "done");
    $btnDownload.disabled = state !== "idle";
  }

  async function downloadClip() {
    if (isBusy || !currentURL) return;

    hideError($dlError);
    isBusy = true;
    setDownloadState("busy");

    // Build payload
    const payload = { url: currentURL };
    const s = parseTime($inputStart.value);
    const e = parseTime($inputEnd.value);

    // Only send timestamps if user actually trimmed
    const isFullRange =
      (isNaN(s) || s === 0) &&
      (isNaN(e) || Math.abs(e - videoDuration) < 1);

    if (!isFullRange) {
      if (!isNaN(s)) payload.start = $inputStart.value;
      if (!isNaN(e)) payload.end   = $inputEnd.value;
    }

    // Validate order
    if (!isNaN(s) && !isNaN(e) && s >= e) {
      showError($dlError, "Start time must be before end time.");
      isBusy = false;
      setDownloadState("idle");
      return;
    }

    try {
      const res = await fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Download failed (${res.status})`);
      }

      // Extract filename from header or build a safe fallback from video title
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      let filename = match ? decodeURIComponent(match[1]) : "";
      
      if (!filename) {
        const rawTitle = $videoTitle.textContent || "clip";
        const cleanTitle = rawTitle.replace(/[<>:"/\\|?*]/g, "_").trim();
        filename = `${cleanTitle}.mp4`;
      }

      // Trigger browser download
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);

      setDownloadState("done");

      // Reset after a moment
      setTimeout(() => setDownloadState("idle"), 3000);

    } catch (err) {
      showError($dlError, err.message);
      setDownloadState("idle");
    } finally {
      isBusy = false;
    }
  }

  $btnDownload.addEventListener("click", downloadClip);

})();
