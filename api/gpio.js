const { spawn, execSync } = require("child_process");

// BCM pins used
const pins = {
    up: 27,
    down: 22,
    left: 23,
    right: 24,
    grab: 17,
    credit: 25,
};

const CHIP = "gpiochip0";
const holds = new Map(); // direction -> child process

function gpiosetOnce(pin, value) {
    execSync(`gpioset ${CHIP} ${pin}=${value}`);
}

// Initialize all pins LOW safely
for (const pin of Object.values(pins)) {
    try { gpiosetOnce(pin, 0); } catch (_) { }
}

// Hold direction HIGH until released
function hold(direction) {
    const pin = pins[direction];
    if (!pin) return;
    if (holds.has(direction)) return; // already holding

    // --mode=signal keeps the line asserted until process is killed
    const child = spawn("gpioset", ["--mode=signal", CHIP, `${pin}=1`], {
        stdio: "ignore",
    });

    holds.set(direction, child);

    child.on("exit", () => {
        holds.delete(direction);
    });
}

// Release direction (stop hold + force LOW)
function release(direction) {
    const pin = pins[direction];
    if (!pin) return;

    const child = holds.get(direction);
    if (child) {
        child.kill("SIGTERM");
        holds.delete(direction);
    }

    gpiosetOnce(pin, 0);
}

// Pulse HIGH for ms then LOW (grab/credit)
function pulse(direction, ms = 250) {
    const pin = pins[direction];
    if (!pin) return;

    gpiosetOnce(pin, 1);
    setTimeout(() => gpiosetOnce(pin, 0), ms);
}

// Safety: release everything
function releaseAll() {
    for (const dir of Object.keys(pins)) {
        release(dir);
    }
}

process.on("SIGINT", () => {
    releaseAll();
    process.exit();
});

module.exports = { hold, release, pulse, releaseAll, pins };
