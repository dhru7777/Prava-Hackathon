export type StoredLocation = {
    chatId: string;
    handle: string;
    longitude: number;
    latitude: number;
    altitude?: number | null;
    address?: string | null;
    locality?: string | null;
    updatedAt: string; // from Linq or when we saved
    savedAt: string;   // when our server wrote the file
  };
  
  // ---------- SELF-TEST ----------
  function selfTest() {
    console.log("\n=== FILE L1: types/location.ts ===");
    const sample: StoredLocation = {
      chatId: "chat_1",
      handle: "dheerajmaske2001@gmail.com",
      longitude: -73.9967,
      latitude: 40.7295,
      address: "NYU area",
      locality: "New York",
      updatedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };
    console.log("sample =", sample);
    console.log(typeof sample.latitude === "number" ? "PASS lat" : "FAIL lat");
    console.log(typeof sample.longitude === "number" ? "PASS lng" : "FAIL lng");
    console.log("RESULT: FILE L1 OK ✅\n");
  }
  
  const runningThisFile = process.argv[1]?.includes("types/location.ts");
  if (runningThisFile) selfTest();