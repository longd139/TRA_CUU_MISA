import { jsonResponse } from '../../_utils.js';

export async function onRequestGet() {
  return jsonResponse({
    success: true,
    sync: {
      running: false,
      step: 0,
      totalSteps: 4,
      stepTitle: 'Cloudflare Pages 24/7',
      percent: 100,
      detail: 'Hệ thống đang phục vụ trực tuyến 24/7 trên mạng biên toàn cầu Cloudflare.',
      itemsProcessed: 0,
      totalItems: 0,
      startedAt: null,
      finishedAt: new Date().toISOString(),
      error: null
    },
    images: {
      running: false,
      total: 0,
      processed: 0,
      filled: 0,
      skipped: 0,
      percent: 100,
      currentSku: '',
      elapsedSec: 0,
      message: 'Hình ảnh được phục vụ trực tiếp từ Cloudinary CDN.',
      startedAt: null,
      finishedAt: null
    }
  });
}
