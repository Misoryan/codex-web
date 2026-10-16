type FontFaceInfo = {
  family: string;
  fullName: string;
  postscriptName: string;
  styleName: string;
  isMonospaced: boolean;
};

const candidates: FontFaceInfo[] = [];
for (const variant of ["SC", "TC", "HK"]) {
  for (const styleName of [
    "Regular",
    "Medium",
    "Semibold",
    "Light",
    "Thin",
    "Ultralight",
  ]) {
    candidates.push({
      family: `PingFang ${variant}`,
      fullName: `PingFang ${variant} ${styleName}`,
      postscriptName: `PingFang${variant}-${styleName}`,
      styleName,
      isMonospaced: false,
    });
  }
}
for (const family of [
  "Microsoft YaHei",
  "Microsoft JhengHei",
  "DengXian",
  "SimSun",
  "SimHei",
  "Segoe UI",
  "Arial",
  "Inter",
  "Georgia",
  "Consolas",
  "Cascadia Code",
  "JetBrains Mono",
]) {
  candidates.push({
    family,
    fullName: family,
    postscriptName: family,
    styleName: "Regular",
    isMonospaced: ["Consolas", "Cascadia Code", "JetBrains Mono"].includes(
      family,
    ),
  });
}

export const browserSystemFonts = {
  async getFontFamilies() {
    const available = await Promise.all(
      candidates.map(async (face) => {
        const escape = (name: string) =>
          name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        try {
          await new FontFace(
            "Codex font availability",
            `local("${escape(face.postscriptName)}"), local("${escape(face.fullName)}")`,
          ).load();
          return face;
        } catch {
          return null;
        }
      }),
    );
    const families = new Map<
      string,
      { family: string; faces: FontFaceInfo[] }
    >();
    for (const face of available) {
      if (face === null) continue;
      let entry = families.get(face.family);
      if (!entry)
        families.set(face.family, (entry = { family: face.family, faces: [] }));
      entry.faces.push(face);
    }
    return Array.from(families.values());
  },
};
