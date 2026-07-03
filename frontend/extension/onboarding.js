const steps = [...document.querySelectorAll(".step")];
const dots = [...document.querySelectorAll(".dot")];
const backBtn = document.getElementById("back-btn");
const nextBtn = document.getElementById("next-btn");

let currentIndex = 0;

function showStep(index) {
  steps.forEach((step, i) => step.classList.toggle("hidden", i !== index));
  dots.forEach((dot, i) => dot.classList.toggle("active", i === index));
  backBtn.classList.toggle("hidden", index === 0);
  nextBtn.textContent = index === steps.length - 1 ? "Start my first session" : "Next";
  currentIndex = index;
}

backBtn.addEventListener("click", () => {
  if (currentIndex > 0) showStep(currentIndex - 1);
});

nextBtn.addEventListener("click", () => {
  if (currentIndex < steps.length - 1) {
    showStep(currentIndex + 1);
  } else {
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id != null) chrome.tabs.remove(tab.id);
    });
  }
});

showStep(0);
