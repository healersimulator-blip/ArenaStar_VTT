import { imageString } from "../ui/images/strings";

/**
 * Frame size of a video, read from its metadata alone (Phase 4). The element is released before the
 * promise settles, so the browser does not keep decoding a file the GM may not use.
 */
export function readVideoSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const release = (): void => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
    };
    video.onloadedmetadata = () => {
      const size = { width: video.videoWidth, height: video.videoHeight };
      release();
      if (size.width < 1 || size.height < 1) reject(new Error(imageString("videoNoPicture")));
      else resolve(size);
    };
    video.onerror = () => {
      release();
      reject(new Error(imageString("videoUnreadable")));
    };
    video.src = url;
  });
}
