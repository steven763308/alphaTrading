import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0b0e13" }}>
        <div style={{ width: 400, height: 400, borderRadius: 88, background: "#3987e5", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 200, fontWeight: 800 }}>
          BX
        </div>
      </div>
    ),
    size,
  );
}
