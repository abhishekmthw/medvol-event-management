/* eslint-disable @next/next/no-img-element */
import clsx from "clsx";

export function MedVolLogo({
  className,
  size = 32,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <img
      src="/logo.png"
      alt="MedVol"
      width={size}
      height={size}
      className={clsx(
        "object-contain",
        "dark:[filter:drop-shadow(0_0_1px_rgba(255,255,255,0.9))_drop-shadow(0_0_2px_rgba(255,255,255,0.6))]",
        className,
      )}
      style={{ height: size, width: "auto" }}
    />
  );
}
