(() => {
  const profile = {
  "firstName": "Shivani",
  "lastName": "Patel",
  "fullName": "Shivani Patel",
  "email": "shivanip064@gmail.com",
  "phone": "5706044594",
  "addressLine1": "637 Cherry Orchard Rd",
  "city": "Canton",
  "state": "MI",
  "stateFull": "Michigan",
  "zipCode": "48188",
  "country": "United States",
  "countryFull": "United States of America",
  "phoneDeviceType": "Mobile",
  "hearAboutUs": "Job Board",
  "workAuthorized": "Yes",
  "sponsorshipRequired": "No",
  "school": "The Maharaja Sayajirao University of Baroda",
  "degree": "Bachelor's Degree",
  "degreeValue": "Bachelors",
  "fieldOfStudy": "Health Administration",
  "fieldOfStudyValue": "Health_Administration",
  "experienceTitle": "Client Enrollment and Growth Coordinator",
  "experienceCompany": "Shantiniketan Adult Day Care",
  "experienceLocation": "Canton, MI",
  "experienceStart": "07/2022",
  "experienceEnd": "02/2026",
  "experienceDescription": "Managed client intake, registration, enrollment documentation, attendance records, care instructions, medication logs, scheduling follow-up, and family communication for an adult day care program that grew from about 30 participants to more than 130.",
  "salaryExpectation": "$50,000-$60,000 annually, depending on schedule, benefits, and healthcare office or patient services setting"
};
  window.localStorage.setItem('careerOpsProfile', JSON.stringify(profile));
  const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fire = el => ['input', 'change', 'blur'].forEach(type => el.dispatchEvent(new Event(type, { bubbles: true })));
  const setNative = (el, value) => {
    if (!el || value == null || value === '') return false;
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    fire(el);
    return true;
  };
  const labelFor = el => {
    const bits = [el.id, el.name, el.placeholder, el.getAttribute('aria-label')];
    const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (label) bits.push(label.innerText);
    bits.push(el.closest('label')?.innerText);
    bits.push(el.closest('[role=group], div, section')?.innerText?.slice(0, 160));
    return norm(bits.filter(Boolean).join(' '));
  };
  const pick = label => {
    if (/first name|given name/.test(label)) return profile.firstName;
    if (/last name|family name|surname/.test(label)) return profile.lastName;
    if (/full name/.test(label)) return profile.fullName;
    if (/email/.test(label)) return profile.email;
    if (/phone|mobile|cell/.test(label)) return profile.phone;
    if (/address line 1|street|address/.test(label)) return profile.addressLine1;
    if (/city/.test(label)) return profile.city;
    if (/postal|zip/.test(label)) return profile.zipCode;
    if (/job title/.test(label)) return profile.experienceTitle;
    if (/company name/.test(label)) return profile.experienceCompany;
    if (/school|university/.test(label)) return profile.school;
    if (/role description|description/.test(label)) return profile.experienceDescription;
    if (/salary|compensation/.test(label)) return profile.salaryExpectation;
    return '';
  };
  let filled = 0;
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea')) {
    if (el.value) continue;
    const value = pick(labelFor(el));
    if (setNative(el, value)) filled++;
  }
  for (const el of document.querySelectorAll('select')) {
    const label = labelFor(el);
    const wanted = /state/.test(label) ? [profile.stateFull, profile.state] :
      /country phone|phone code/.test(label) ? ['United States of America (+1)', 'USA_1', '+1'] :
      /country/.test(label) ? [profile.countryFull, profile.country] :
      /phone device|device type/.test(label) ? ['Cell', 'Mobile'] :
      /source|hear about/.test(label) ? [profile.hearAboutUs] :
      /degree/.test(label) ? [profile.degree, profile.degreeValue] :
      /field of study/.test(label) ? [profile.fieldOfStudy, profile.fieldOfStudyValue] : [];
    const option = Array.from(el.options).find(opt => wanted.some(w => norm(opt.text) === norm(w) || norm(opt.value) === norm(w)));
    if (option && setNative(el, option.value)) filled++;
  }
  console.log('career-ops autofill complete:', filled, 'fields filled');
  return { filled, profile };
})();