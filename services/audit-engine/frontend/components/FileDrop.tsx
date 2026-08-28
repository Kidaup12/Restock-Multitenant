"use client";

import { useCallback, useRef, useState } from "react";

interface Props {
  label: string;
  required?: boolean;
  file: File | null;
  onFile: (f: File | null) => void;
}

export default function FileDrop({ label, required, file, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) onFile(dropped);
    },
    [onFile],
  );

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-sm font-medium text-gray-700">
          {label}
          {required ? (
            <span className="ml-1 text-red-500">*</span>
          ) : (
            <span className="ml-1 text-xs font-normal text-gray-400">
              (optional)
            </span>
          )}
        </label>
        {file && (
          <button
            type="button"
            onClick={() => {
              onFile(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="text-xs text-gray-400 hover:text-gray-600"
          >
            clear
          </button>
        )}
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer items-center justify-center rounded-lg border border-dashed px-4 py-6 text-sm transition-colors ${
          dragOver
            ? "border-indigo-400 bg-indigo-50"
            : file
              ? "border-gray-300 bg-white"
              : "border-gray-300 bg-gray-50 hover:border-gray-400"
        }`}
      >
        {file ? (
          <span className="truncate font-medium text-gray-800">
            {file.name}
            <span className="ml-2 font-normal text-gray-400">
              {(file.size / 1024).toFixed(0)} KB
            </span>
          </span>
        ) : (
          <span className="text-gray-500">
            Drop CSV here or{" "}
            <span className="font-medium text-indigo-600">browse</span>
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}
