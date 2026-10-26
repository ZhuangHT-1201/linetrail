importScripts("./line-art.js");

self.onmessage = function (event) {
  const { id, data, width, height, options } = event.data;

  try {
    const result = LineArtEngine.process(
      new Uint8ClampedArray(data),
      width,
      height,
      options,
      function (progress, detail) {
        self.postMessage({
          type: "progress",
          id,
          progress,
          detail
        });
      }
    );

    self.postMessage(
      {
        type: "result",
        id,
        width: result.width,
        height: result.height,
        duration: result.duration,
        mask: result.mask.buffer
      },
      [result.mask.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error)
    });
  }
};
