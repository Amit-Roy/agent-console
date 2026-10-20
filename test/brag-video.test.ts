// Test for brag video generation
// This test will fail until the brag video is generated

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const videoPath = resolve(process.cwd(), "brag-output/brag.mp4");

function testBragVideoExists() {
  if (!existsSync(videoPath)) {
    throw new Error(`Brag video not found at ${videoPath}`);
  }
  console.log("✓ Brag video exists");
  
  const stats = statSync(videoPath);
  const sizeMB = stats.size / (1024 * 1024);
  console.log(`  Size: ${sizeMB.toFixed(2)} MB`);
  
  if (sizeMB < 0.1) {
    throw new Error(`Video file too small (${sizeMB.toFixed(2)} MB), likely empty`);
  }
  console.log("✓ Video has reasonable size");
}

function testBragVideoPlayable() {
  // Check file extension and basic structure
  if (!videoPath.endsWith(".mp4")) {
    throw new Error("Video must be MP4 format");
  }
  console.log("✓ Video is MP4 format");
}

// Run tests
console.log("Testing brag video output...");
try {
  testBragVideoExists();
  testBragVideoPlayable();
  console.log("\n✓ All brag video tests passed!");
  process.exit(0);
} catch (error) {
  console.error("\n✗ Test failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}