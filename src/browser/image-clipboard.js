export async function codexWebImagePng(blob) {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw Error('Could not create image clipboard canvas');
    context.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!png) throw Error('Could not encode image for clipboard copy');
  return png;
}

export async function codexWebCopyImage(blob) {
  const png = Promise.resolve(blob).then(codexWebImagePng);
  png.catch(() => {});
  // Start the clipboard write during the menu action, before decoding the image.
  return navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
}
