// Positions #__vikunja-today-line (see inject.css) on top of the Gantt
// chart's date column that matches "today", per go-vikunja/vikunja's
// GanttTimelineHeader.vue: the current-day cell gets a
// `.timeunit-wrapper.today` class inside `.timeunit`, and the whole
// scrollable chart lives in `.gantt-chart-wrapper`. We read that cell's
// position instead of recomputing dayWidthPixels ourselves, so this stays
// correct across window resizes and date-range changes without needing to
// touch Vikunja's own layout logic.
(function () {
	'use strict';

	const LINE_ID = '__vikunja-today-line';

	function ensureLine(wrapper) {
		let line = wrapper.querySelector('#' + LINE_ID);
		if (!line) {
			line = document.createElement('div');
			line.id = LINE_ID;
			wrapper.appendChild(line);
		}
		return line;
	}

	function reposition() {
		const wrapper = document.querySelector('.gantt-chart-wrapper');
		if (!wrapper) return;

		const todayCell = wrapper.querySelector('.timeunit-wrapper.today');
		const existingLine = wrapper.querySelector('#' + LINE_ID);

		// Today isn't inside the currently selected date range: nothing to draw.
		if (!todayCell) {
			if (existingLine) existingLine.remove();
			return;
		}

		const timeunit = todayCell.closest('.timeunit');
		if (!timeunit) return;

		const wrapperRect = wrapper.getBoundingClientRect();
		const cellRect = timeunit.getBoundingClientRect();
		const centerX = cellRect.left - wrapperRect.left + cellRect.width / 2;

		ensureLine(wrapper).style.left = centerX + 'px';
	}

	let scheduled = false;
	function scheduleReposition() {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			reposition();
		});
	}

	// Vikunja is an SPA (no full page reload between views), so watch the DOM
	// for the Gantt chart mounting/unmounting/re-rendering instead of relying
	// on page-load timing.
	new MutationObserver(scheduleReposition).observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['class', 'style'],
	});

	window.addEventListener('resize', scheduleReposition);

	// Vikunja's own "today" highlight is reactive and rolls over at midnight
	// without a page reload (useGlobalNow()); re-check periodically so ours does too.
	setInterval(scheduleReposition, 60 * 1000);

	scheduleReposition();
})();
