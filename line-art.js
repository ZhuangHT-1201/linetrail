(function (root) {
  "use strict";

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  function smoothstep(edge0, edge1, value) {
    const x = clamp((value - edge0) / Math.max(0.00001, edge1 - edge0), 0, 1);
    return x * x * (3 - 2 * x);
  }

  function compositeGray(rgba, width, height) {
    const gray = new Float32Array(width * height);
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const alpha = rgba[p + 3] / 255;
      const luminance =
        rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722;
      gray[i] = luminance * alpha + 255 * (1 - alpha);
    }
    return gray;
  }

  /**
   * Separable box blur with edge replication. A two-pass box blur gives a light
   * halo-free foundation for the line detector without requiring WebGL.
   */
  function boxBlur(source, width, height, radius) {
    if (radius <= 0) {
      return new Float32Array(source);
    }

    const temporary = new Float32Array(source.length);
    const output = new Float32Array(source.length);
    const diameter = radius * 2 + 1;

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        sum += source[row + clamp(k, 0, width - 1)];
      }
      temporary[row] = sum / diameter;
      for (let x = 1; x < width; x += 1) {
        const outgoing = row + clamp(x - radius - 1, 0, width - 1);
        const incoming = row + clamp(x + radius, 0, width - 1);
        sum += source[incoming] - source[outgoing];
        temporary[row + x] = sum / diameter;
      }
    }

    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        sum += temporary[clamp(k, 0, height - 1) * width + x];
      }
      output[x] = sum / diameter;
      for (let y = 1; y < height; y += 1) {
        const outgoing = clamp(y - radius - 1, 0, height - 1) * width + x;
        const incoming = clamp(y + radius, 0, height - 1) * width + x;
        sum += temporary[incoming] - temporary[outgoing];
        output[y * width + x] = sum / diameter;
      }
    }

    return output;
  }

  /**
   * Edge-preserving smoothing lowers fabric, skin and compression noise while
   * retaining the stronger tonal boundaries that make a convincing line drawing.
   */
  function bilateralFilter(source, width, height, radius, rangeSigma) {
    if (radius <= 0) {
      return new Float32Array(source);
    }

    const output = new Float32Array(source.length);
    const rangeWeights = new Float32Array(256);
    for (let difference = 0; difference < 256; difference += 1) {
      rangeWeights[difference] = Math.exp(
        -(difference * difference) / (2 * rangeSigma * rangeSigma)
      );
    }

    const spatial = [];
    const spatialSigma = Math.max(1, radius * 0.82);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const distance = offsetX * offsetX + offsetY * offsetY;
        if (distance > radius * radius) continue;
        spatial.push({
          x: offsetX,
          y: offsetY,
          weight: Math.exp(
            -distance / (2 * spatialSigma * spatialSigma)
          )
        });
      }
    }

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = row + x;
        const center = source[index];
        let weightedSum = center;
        let totalWeight = 1;

        for (let s = 0; s < spatial.length; s += 1) {
          const neighborX = clamp(x + spatial[s].x, 0, width - 1);
          const neighborY = clamp(y + spatial[s].y, 0, height - 1);
          const neighbor = source[neighborY * width + neighborX];
          const difference = Math.abs(Math.round(neighbor - center));
          const weight = spatial[s].weight * rangeWeights[difference];
          weightedSum += neighbor * weight;
          totalWeight += weight;
        }

        output[index] = weightedSum / totalWeight;
      }
    }

    return output;
  }

  function medianFilter(source, width, height, radius) {
    if (radius <= 0) {
      return new Float32Array(source);
    }

    const output = new Float32Array(source.length);
    const values = new Uint8Array((radius * 2 + 1) ** 2);

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        let count = 0;
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          const sourceY = clamp(y + offsetY, 0, height - 1);
          const sourceRow = sourceY * width;
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            const sourceX = clamp(x + offsetX, 0, width - 1);
            values[count] = source[sourceRow + sourceX];
            count += 1;
          }
        }

        const ordered = values.subarray(0, count).sort();
        const middle = count >> 1;
        output[row + x] =
          count % 2 === 0
            ? (ordered[middle - 1] + ordered[middle]) * 0.5
            : ordered[middle];
      }
    }

    return output;
  }

  /**
   * Sobel edges with non-maximum suppression and hysteresis. The result is a
   * continuous 0..1 mask instead of a hard black-and-white bitmap.
   */
  function detectEdges(source, width, height, lowThreshold) {
    const magnitude = new Float32Array(source.length);
    const highThreshold = lowThreshold * 2.25;

    for (let y = 1; y < height - 1; y += 1) {
      const row = y * width;
      for (let x = 1; x < width - 1; x += 1) {
        const i = row + x;
        const topLeft = source[i - width - 1];
        const top = source[i - width];
        const topRight = source[i - width + 1];
        const left = source[i - 1];
        const right = source[i + 1];
        const bottomLeft = source[i + width - 1];
        const bottom = source[i + width];
        const bottomRight = source[i + width + 1];

        const gx =
          -topLeft + topRight - left * 2 + right * 2 - bottomLeft + bottomRight;
        const gy =
          -topLeft - top * 2 - topRight + bottomLeft + bottom * 2 + bottomRight;
        magnitude[i] = Math.sqrt(gx * gx + gy * gy) * 0.25;

        const absX = Math.abs(gx);
        const absY = Math.abs(gy);
        let first;
        let second;

        if (absX > absY * 2.3) {
          first = magnitude[i - 1];
          second = magnitude[i + 1];
        } else if (absY > absX * 2.3) {
          first = magnitude[i - width];
          second = magnitude[i + width];
        } else if (gx * gy > 0) {
          first = magnitude[i - width - 1];
          second = magnitude[i + width + 1];
        } else {
          first = magnitude[i - width + 1];
          second = magnitude[i + width - 1];
        }

        if (magnitude[i] < first || magnitude[i] < second) {
          magnitude[i] = 0;
        }
      }
    }

    // 0 = empty, 128 = weak edge, 255 = confirmed edge.
    const state = new Uint8Array(source.length);
    const queue = new Int32Array(source.length);
    let tail = 0;

    for (let i = width + 1; i < source.length - width - 1; i += 1) {
      const value = magnitude[i];
      if (value >= highThreshold) {
        state[i] = 255;
        queue[tail] = i;
        tail += 1;
      } else if (value >= lowThreshold) {
        state[i] = 128;
      }
    }

    let head = 0;
    while (head < tail) {
      const current = queue[head];
      head += 1;
      const x = current % width;
      const y = (current / width) | 0;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY <= 0 || nextY >= height - 1) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          if (nextX <= 0 || nextX >= width - 1) continue;
          const next = nextY * width + nextX;
          if (state[next] === 128) {
            state[next] = 255;
            queue[tail] = next;
            tail += 1;
          }
        }
      }
    }

    const edges = new Float32Array(source.length);
    for (let i = 0; i < edges.length; i += 1) {
      if (state[i] === 255) {
        const normalized = (magnitude[i] - lowThreshold) / (highThreshold - lowThreshold);
        edges[i] = 0.48 + clamp(normalized, 0, 1) * 0.52;
      }
    }
    return edges;
  }

  function dilate(mask, width, height, radius) {
    let current = mask;
    for (let pass = 0; pass < radius; pass += 1) {
      const next = new Float32Array(current);
      for (let y = 1; y < height - 1; y += 1) {
        const row = y * width;
        for (let x = 1; x < width - 1; x += 1) {
          const i = row + x;
          const value = Math.max(
            current[i],
            current[i - 1],
            current[i + 1],
            current[i - width],
            current[i + width],
            current[i - width - 1] * 0.78,
            current[i - width + 1] * 0.78,
            current[i + width - 1] * 0.78,
            current[i + width + 1] * 0.78
          );
          next[i] = value;
        }
      }
      current = next;
    }
    return current;
  }

  function removeSpecks(mask, width, height) {
    const visited = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    const minimumPixels = Math.max(12, Math.round(width * height * 0.000025));

    for (let start = 0; start < mask.length; start += 1) {
      if (visited[start] || mask[start] < 0.055) continue;

      let head = 0;
      let tail = 1;
      queue[0] = start;
      visited[start] = 1;

      while (head < tail) {
        const current = queue[head];
        head += 1;
        const x = current % width;
        const y = (current / width) | 0;

        if (x > 0) {
          const next = current - 1;
          if (!visited[next] && mask[next] >= 0.055) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
        if (x < width - 1) {
          const next = current + 1;
          if (!visited[next] && mask[next] >= 0.055) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
        if (y > 0) {
          const next = current - width;
          if (!visited[next] && mask[next] >= 0.055) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
        if (y < height - 1) {
          const next = current + width;
          if (!visited[next] && mask[next] >= 0.055) {
            visited[next] = 1;
            queue[tail] = next;
            tail += 1;
          }
        }
      }

      if (tail < minimumPixels) {
        for (let i = 0; i < tail; i += 1) {
          mask[queue[i]] = 0;
        }
      }
    }

    return mask;
  }

  const STYLE_PRESETS = {
    pencil: {
      thresholdFactor: 1,
      thresholdSpan: 8.5,
      edgeGain: 0.86,
      valleyGain: 0.13,
      dodgeGain: 0.04,
      gamma: 0.92
    },
    ink: {
      thresholdFactor: 1.28,
      thresholdSpan: 9.5,
      edgeGain: 1.15,
      valleyGain: 0.07,
      dodgeGain: 0.02,
      gamma: 0.8
    },
    sketch: {
      thresholdFactor: 0.78,
      thresholdSpan: 6.2,
      edgeGain: 0.58,
      valleyGain: 0.45,
      dodgeGain: 0.26,
      gamma: 0.98
    }
  };

  function process(imageData, width, height, options, report) {
    const startedAt = performance.now();
    const preset = STYLE_PRESETS[options.mode] || STYLE_PRESETS.pencil;
    const detail = clamp(Number(options.detail) / 100, 0, 1);
    const intensity = clamp(Number(options.intensity) / 100, 0, 1);
    const thickness = clamp(Math.round(Number(options.thickness)), 1, 3);
    const notify = typeof report === "function" ? report : function () {};

    notify(0.03, "Reading pixels and tones");
    const gray = compositeGray(imageData, width, height);

    notify(0.13, "Smoothing texture");
    const isLargeImage = width * height > 4500000;
    const bilateralRadius = isLargeImage ? 1 : 2;
    const denoised = bilateralFilter(gray, width, height, bilateralRadius, 24);
    const edgeBase = medianFilter(denoised, width, height, isLargeImage ? 1 : 2);
    const smooth = boxBlur(edgeBase, width, height, 1);

    const shortestSide = Math.min(width, height);
    const detailRadius = clamp(
      Math.round(2 + (1 - detail) * Math.min(4, shortestSide / 260)),
      2,
      7
    );
    const textureRadius = clamp(detailRadius + 2, 4, 12);

    notify(0.27, "Tracing contours");
    const lowThreshold =
      (7.4 + (1 - detail) * preset.thresholdSpan) * preset.thresholdFactor;
    const edges = detectEdges(smooth, width, height, lowThreshold);

    notify(0.58, "Rendering local tone");
    const localMean = boxBlur(denoised, width, height, detailRadius);
    const textureMean = boxBlur(denoised, width, height, textureRadius);

    const mask = new Float32Array(gray.length);
    const gain = 0.24 + intensity * 1.03;
    const whiteCutoff = 247;

    for (let i = 0; i < gray.length; i += 1) {
      const value = denoised[i];
      const local = localMean[i];
      const texture = textureMean[i];

      const valley = smoothstep(6, 24, local - value);
      const dodge = clamp((texture - value) / Math.max(24, texture), 0, 1);
      const dodgeInk = smoothstep(0.035, 0.31, dodge);
      const lightProtection = smoothstep(whiteCutoff, 254.5, value);
      const shadowProtection = smoothstep(8, 42, value);

      let alpha =
        edges[i] * preset.edgeGain +
        valley * preset.valleyGain * shadowProtection +
        dodgeInk * preset.dodgeGain;

      alpha *= (1 - lightProtection * 0.92) * gain;
      alpha = smoothstep(0.018, 0.91, alpha);
      alpha = Math.pow(alpha, preset.gamma);
      mask[i] = clamp(alpha, 0, 1);
    }

    let finalMask = mask;
    if (options.cleanup) {
      notify(0.78, "Removing specks");
      finalMask = removeSpecks(finalMask, width, height);
    }

    if (thickness > 1) {
      notify(0.88, "Adjusting line width");
      finalMask = dilate(finalMask, width, height, thickness - 1);
    }

    // Ease the lowest intensities to zero so transparent exports do not contain
    // a faint rectangular film from image compression noise.
    for (let i = 0; i < finalMask.length; i += 1) {
      if (finalMask[i] < 0.025) {
        finalMask[i] = 0;
      }
    }

    notify(1, "Finishing artwork");
    return {
      mask: finalMask,
      width,
      height,
      duration: Math.max(1, Math.round(performance.now() - startedAt))
    };
  }

  root.LineArtEngine = {
    process,
    boxBlur,
    detectEdges
  };
})(typeof self !== "undefined" ? self : globalThis);
