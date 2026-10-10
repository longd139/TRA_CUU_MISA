export async function onRequestGet(context) {
  const { params, env } = context;
  const filename = params.filename || '';
  const picId = filename.replace(/\.(jpg|jpeg|png|webp)$/i, '');
  const cleanPicId = picId.replace(/[^a-zA-Z0-9_-]/g, '_');

  const cloudName = env.CLOUDINARY_CLOUD_NAME || 'pv0t9rx7';
  const cloudUrl = `https://res.cloudinary.com/${cloudName}/image/upload/f_auto,q_auto/cobe-inventory/${cleanPicId}.jpg`;

  return Response.redirect(cloudUrl, 302);
}
